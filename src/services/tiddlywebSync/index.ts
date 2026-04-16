/**
 * TiddlyWebSync service — synchronises a TidGi workspace with a remote
 * TiddlyWiki NodeJS server (TiddlyWeb-compatible REST API).
 *
 * Flow per sync pass:
 *   1. Resolve workspace, build HTTP client, load sync state.
 *   2. Snapshot local tiddlers (filtered by the workspace's exclude filter).
 *   3. List remote tiddler summaries.
 *   4. Run the pure `reconcile()` to compute actions.
 *   5. Apply actions (pull/push/delete/conflict) one tiddler at a time.
 *      We do NOT parallelise here: TW's wiki worker is single-threaded for
 *      mutations and the HTTP server is happiest with serial PUTs from one
 *      client. Per-action errors are logged and counted but don't abort the
 *      whole pass — one bad tiddler shouldn't block the other 5000.
 *   6. Persist updated sync state.
 *
 * Concurrency:
 *   - At most one in-flight sync per workspace (mutex via `inFlight` map).
 *   - Concurrent calls to `syncWorkspace` await the in-flight one rather than
 *     starting a new one. This is what the timer + a manual "sync now" button
 *     can rely on.
 */

import { inject, injectable } from 'inversify';
import { Subject, Observable } from 'rxjs';

import { WikiChannel } from '@/constants/channels';
import type { IAuthenticationService } from '@services/auth/interface';
import { container } from '@services/container';
import { logger } from '@services/libs/log';
import serviceIdentifier from '@services/serviceIdentifier';
import { SupportedStorageServices } from '@services/types';
import type { IWikiService } from '@services/wiki/interface';
import type { IWorkspaceService } from '@services/workspaces/interface';
import { isWikiWorkspace } from '@services/workspaces/interface';

import { TiddlyWebClient, type TiddlerFields } from './client';
import { computeTiddlerHash } from './hash';
import type {
  ITiddlyWebSyncService,
  TiddlyWebConnectionResult,
  TiddlyWebSyncProgressEvent,
  TiddlyWebSyncResult,
  TiddlyWebSyncStatus,
} from './interface';
import {
  type LocalTiddlerState,
  type RemoteTiddlerState,
  reconcile,
  summarise,
  type SyncAction,
  type SyncStateEntry,
} from './reconciler';
import { TiddlyWebSyncStateStore } from './stateStore';

/** Tiddler title prefix where we save pre-overwrite local copies on conflict. */
const CONFLICT_BACKUP_PREFIX = '$:/sync/conflicts/';

/** Temporary tiddler that holds the user's exclude filter so we can use it via `subfilter{...}`. */
const EXCLUDE_FILTER_TEMP_TITLE = '$:/temp/tidgi/tiddlyweb-sync-exclude';

@injectable()
export class TiddlyWebSync implements ITiddlyWebSyncService {
  private readonly stateStores = new Map<string, TiddlyWebSyncStateStore>();
  private readonly inFlight = new Map<string, Promise<TiddlyWebSyncResult | undefined>>();
  private readonly progressSubjects = new Map<string, Subject<TiddlyWebSyncProgressEvent>>();
  private readonly lastErrors = new Map<string, string>();

  constructor(
    @inject(serviceIdentifier.Authentication) private readonly authService: IAuthenticationService,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────────────────

  public async syncWorkspace(workspaceId: string): Promise<TiddlyWebSyncResult | undefined> {
    const existing = this.inFlight.get(workspaceId);
    if (existing) {
      logger.debug('TiddlyWebSync: joining in-flight sync', { workspaceId });
      return existing;
    }
    const promise = this.runSync(workspaceId).finally(() => {
      this.inFlight.delete(workspaceId);
    });
    this.inFlight.set(workspaceId, promise);
    return promise;
  }

  public async testConnection(workspaceId: string): Promise<TiddlyWebConnectionResult> {
    try {
      const client = await this.buildClient(workspaceId);
      if (!client) {
        return { reachable: false, error: 'Workspace is not a TiddlyWeb workspace or is missing tiddlywebUrl' };
      }
      const reachable = await client.checkReachable();
      return { reachable };
    } catch (error) {
      return { reachable: false, error: (error as Error).message };
    }
  }

  public async resetSyncState(workspaceId: string): Promise<void> {
    const store = await this.getStateStore(workspaceId);
    store.clearAll();
    await store.save();
    logger.info('TiddlyWebSync: sync state reset', { workspaceId });
  }

  public async getStatus(workspaceId: string): Promise<TiddlyWebSyncStatus> {
    const workspace = await this.getWorkspaceIfTiddlyWeb(workspaceId);
    const configured = workspace !== undefined && Boolean(workspace.tiddlywebUrl);
    let trackedTiddlerCount = 0;
    let lastFullSyncAt: number | undefined;
    if (configured) {
      const store = await this.getStateStore(workspaceId);
      trackedTiddlerCount = store.size();
      lastFullSyncAt = store.getLastFullSyncAt();
    }
    return {
      workspaceId,
      configured,
      trackedTiddlerCount,
      lastFullSyncAt,
      lastError: this.lastErrors.get(workspaceId),
      inFlight: this.inFlight.has(workspaceId),
    };
  }

  public progress$(workspaceId: string): Observable<TiddlyWebSyncProgressEvent> {
    return this.getProgressSubject(workspaceId).asObservable();
  }

  // ────────────────────────────────────────────────────────────────────────
  // Core sync flow
  // ────────────────────────────────────────────────────────────────────────

  private async runSync(workspaceId: string): Promise<TiddlyWebSyncResult | undefined> {
    const startedAt = Date.now();
    const progress = this.getProgressSubject(workspaceId);
    progress.next({ phase: 'started', workspaceId });

    try {
      const workspace = await this.getWorkspaceIfTiddlyWeb(workspaceId);
      if (!workspace) {
        logger.debug('TiddlyWebSync: skipping non-tiddlyweb workspace', { workspaceId });
        return undefined;
      }
      if (!workspace.tiddlywebUrl) {
        throw new Error('TiddlyWebSync: tiddlywebUrl is not configured for this workspace');
      }

      const wikiService = container.get<IWikiService>(serviceIdentifier.Wiki);
      const password = (await this.authService.get('tiddlyweb-token')) ?? '';
      const client = new TiddlyWebClient({
        baseUrl: workspace.tiddlywebUrl,
        recipe: workspace.tiddlywebRecipe ?? 'default',
        username: workspace.tiddlywebUsername ?? '',
        password,
      });

      const store = await this.getStateStore(workspaceId);
      store.ensureFingerprint(`${workspace.tiddlywebUrl}|${workspace.tiddlywebRecipe ?? 'default'}`);

      // ── 1. Read local tiddlers ────────────────────────────────────────
      progress.next({ phase: 'reading-local', workspaceId });
      const excludeFilter = workspace.tiddlywebExcludeFilter && workspace.tiddlywebExcludeFilter.trim().length > 0
        ? workspace.tiddlywebExcludeFilter
        : '[prefix[$:/]]';
      const localFieldsList = await this.readLocalTiddlers(workspaceId, excludeFilter);
      const localFieldsByTitle = new Map<string, TiddlerFields>();
      const local = new Map<string, LocalTiddlerState>();
      for (const fields of localFieldsList) {
        if (typeof fields.title !== 'string') continue;
        localFieldsByTitle.set(fields.title, fields);
        local.set(fields.title, { hash: computeTiddlerHash(fields) });
      }

      // ── 2. List remote tiddlers ───────────────────────────────────────
      progress.next({ phase: 'listing-remote', workspaceId });
      const remoteList = await client.listAll();
      const remote = new Map<string, RemoteTiddlerState>();
      for (const summary of remoteList) {
        remote.set(summary.title, { revision: summary.revision, bag: summary.bag });
      }

      // ── 3. Reconcile ──────────────────────────────────────────────────
      const actions = reconcile({ local, remote, syncState: store.all() });
      const summary = summarise(actions);
      progress.next({ phase: 'reconciled', workspaceId, summary });
      logger.info('TiddlyWebSync: reconciled', { workspaceId, summary });

      // ── 4. Apply actions ──────────────────────────────────────────────
      const errors: TiddlyWebSyncResult['errors'] = [];
      let completed = 0;
      for (const action of actions) {
        progress.next({
          phase: 'applying',
          workspaceId,
          completed,
          total: actions.length,
          currentTitle: 'title' in action ? action.title : undefined,
        });
        try {
          await this.applyAction(action, workspaceId, client, store, localFieldsByTitle, wikiService);
        } catch (error) {
          const message = (error as Error).message ?? String(error);
          errors.push({
            title: 'title' in action ? action.title : '',
            action: action.type,
            message,
          });
          logger.error('TiddlyWebSync: action failed', { workspaceId, action, error });
        }
        completed += 1;
      }

      // ── 5. Persist state ──────────────────────────────────────────────
      store.setLastFullSyncAt(Date.now());
      await store.save();

      const finishedAt = Date.now();
      progress.next({
        phase: 'finished',
        workspaceId,
        summary,
        errors: errors.length,
        elapsedMs: finishedAt - startedAt,
      });
      this.lastErrors.delete(workspaceId);
      logger.info('TiddlyWebSync: sync finished', {
        workspaceId,
        summary,
        errors: errors.length,
        elapsedMs: finishedAt - startedAt,
      });
      return { workspaceId, startedAt, finishedAt, summary, errors };
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      this.lastErrors.set(workspaceId, message);
      logger.error('TiddlyWebSync: sync failed', { workspaceId, error });
      progress.next({ phase: 'error', workspaceId, message });
      throw error;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Action handlers
  // ────────────────────────────────────────────────────────────────────────

  private async applyAction(
    action: SyncAction,
    workspaceId: string,
    client: TiddlyWebClient,
    store: TiddlyWebSyncStateStore,
    localFieldsByTitle: Map<string, TiddlerFields>,
    wikiService: IWikiService,
  ): Promise<void> {
    switch (action.type) {
      case 'pull':
        await this.handlePull(action, workspaceId, client, store, localFieldsByTitle, wikiService);
        break;
      case 'push':
        await this.handlePush(action, store, client, localFieldsByTitle);
        break;
      case 'delete-local':
        await this.handleDeleteLocal(action, workspaceId, store, wikiService);
        break;
      case 'delete-remote':
        await this.handleDeleteRemote(action, store, client);
        break;
      case 'conflict-backup-local':
        await this.handleConflictBackupLocal(action, workspaceId, client, store, localFieldsByTitle, wikiService);
        break;
      case 'clear-sync-state':
        store.deleteEntry(action.title);
        break;
    }
  }

  private async handlePull(
    action: Extract<SyncAction, { type: 'pull' }>,
    workspaceId: string,
    client: TiddlyWebClient,
    store: TiddlyWebSyncStateStore,
    localFieldsByTitle: Map<string, TiddlerFields>,
    wikiService: IWikiService,
  ): Promise<void> {
    const remoteFields = await client.fetchOne(action.title);
    // First-sync safety: stash local copy if it materially differs.
    if (action.backupLocal) {
      const local = localFieldsByTitle.get(action.title);
      if (local && computeTiddlerHash(local) !== computeTiddlerHash(remoteFields)) {
        await this.writeConflictBackup(action.title, local, wikiService, workspaceId);
      }
    }
    await this.writeTiddlerLocally(remoteFields, wikiService, workspaceId);
    store.upsert({
      title: action.title,
      lastKnownRemoteRevision: action.remoteRevision,
      lastSyncedLocalHash: computeTiddlerHash(remoteFields),
      lastSyncedAt: Date.now(),
      bag: remoteFields.bag ?? action.bag,
    });
  }

  private async handlePush(
    action: Extract<SyncAction, { type: 'push' }>,
    store: TiddlyWebSyncStateStore,
    client: TiddlyWebClient,
    localFieldsByTitle: Map<string, TiddlerFields>,
  ): Promise<void> {
    const fields = localFieldsByTitle.get(action.title);
    if (!fields) {
      throw new Error(`handlePush: local tiddler ${action.title} disappeared between read and apply`);
    }
    const result = await client.put(fields);
    const previous = store.get(action.title);
    store.upsert({
      title: action.title,
      lastKnownRemoteRevision: result.revision ?? previous?.lastKnownRemoteRevision ?? '',
      lastSyncedLocalHash: action.localHash,
      lastSyncedAt: Date.now(),
      bag: previous?.bag,
    });
  }

  private async handleDeleteLocal(
    action: Extract<SyncAction, { type: 'delete-local' }>,
    workspaceId: string,
    store: TiddlyWebSyncStateStore,
    wikiService: IWikiService,
  ): Promise<void> {
    await wikiService.wikiOperationInServer(WikiChannel.deleteTiddler, workspaceId, [action.title]);
    store.deleteEntry(action.title);
  }

  private async handleDeleteRemote(
    action: Extract<SyncAction, { type: 'delete-remote' }>,
    store: TiddlyWebSyncStateStore,
    client: TiddlyWebClient,
  ): Promise<void> {
    await client.delete(action.title, action.bag);
    store.deleteEntry(action.title);
  }

  private async handleConflictBackupLocal(
    action: Extract<SyncAction, { type: 'conflict-backup-local' }>,
    workspaceId: string,
    client: TiddlyWebClient,
    store: TiddlyWebSyncStateStore,
    localFieldsByTitle: Map<string, TiddlerFields>,
    wikiService: IWikiService,
  ): Promise<void> {
    const local = localFieldsByTitle.get(action.title);
    if (local) {
      await this.writeConflictBackup(action.title, local, wikiService, workspaceId);
    }
    const remoteFields = await client.fetchOne(action.title);
    await this.writeTiddlerLocally(remoteFields, wikiService, workspaceId);
    store.upsert({
      title: action.title,
      lastKnownRemoteRevision: action.remoteRevision,
      lastSyncedLocalHash: computeTiddlerHash(remoteFields),
      lastSyncedAt: Date.now(),
      bag: remoteFields.bag ?? action.bag,
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Local store I/O helpers
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Snapshot local tiddlers, applying the user's exclude filter.
   *
   * We write the exclude expression to a temp tiddler and reference it via
   * `subfilter{...}`, because TW's filter operand `[]` syntax can't carry
   * arbitrary user input safely (closing brackets break it).
   */
  private async readLocalTiddlers(workspaceId: string, excludeFilter: string): Promise<TiddlerFields[]> {
    const wikiService = container.get<IWikiService>(serviceIdentifier.Wiki);
    await wikiService.wikiOperationInServer(WikiChannel.setTiddlerText, workspaceId, [
      EXCLUDE_FILTER_TEMP_TITLE,
      excludeFilter,
    ]);
    const filter = `[all[tiddlers]] -[subfilter{${EXCLUDE_FILTER_TEMP_TITLE}}]`;
    const result = await wikiService.wikiOperationInServer(WikiChannel.getTiddlersAsJson, workspaceId, [filter]);
    if (!Array.isArray(result)) return [];
    return result as TiddlerFields[];
  }

  private async writeTiddlerLocally(fields: TiddlerFields, wikiService: IWikiService, workspaceId: string): Promise<void> {
    const { title, text, bag: _bag, revision: _revision, ...rest } = fields;
    // We pass server's `created` and `modified` through `rest` so the local
    // copy keeps the same timestamps as the server. addTiddler with default
    // options.withDate=false won't overwrite them.
    await wikiService.wikiOperationInServer(WikiChannel.addTiddler, workspaceId, [
      title,
      text ?? '',
      JSON.stringify(rest),
    ]);
  }

  private async writeConflictBackup(
    originalTitle: string,
    localFields: TiddlerFields,
    wikiService: IWikiService,
    workspaceId: string,
  ): Promise<void> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupTitle = `${CONFLICT_BACKUP_PREFIX}${originalTitle}/${ts}`;
    const { title: _t, text, bag: _bag, revision: _revision, ...rest } = localFields;
    await wikiService.wikiOperationInServer(WikiChannel.addTiddler, workspaceId, [
      backupTitle,
      text ?? '',
      JSON.stringify({
        ...rest,
        // Tag for easy discovery in the wiki UI
        tags: rest.tags ? `${rest.tags} $:/sync/conflict-backup` : '$:/sync/conflict-backup',
        'sync-original-title': originalTitle,
      }),
    ]);
    logger.warn('TiddlyWebSync: saved conflict backup', { workspaceId, originalTitle, backupTitle });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────

  private async getWorkspaceIfTiddlyWeb(workspaceId: string) {
    const workspaceService = container.get<IWorkspaceService>(serviceIdentifier.Workspace);
    const workspace = await workspaceService.get(workspaceId);
    if (!workspace || !isWikiWorkspace(workspace)) return undefined;
    if (workspace.storageService !== SupportedStorageServices.tiddlyweb) return undefined;
    return workspace;
  }

  private async buildClient(workspaceId: string): Promise<TiddlyWebClient | undefined> {
    const workspace = await this.getWorkspaceIfTiddlyWeb(workspaceId);
    if (!workspace?.tiddlywebUrl) return undefined;
    const password = (await this.authService.get('tiddlyweb-token')) ?? '';
    return new TiddlyWebClient({
      baseUrl: workspace.tiddlywebUrl,
      recipe: workspace.tiddlywebRecipe ?? 'default',
      username: workspace.tiddlywebUsername ?? '',
      password,
    });
  }

  private async getStateStore(workspaceId: string): Promise<TiddlyWebSyncStateStore> {
    let store = this.stateStores.get(workspaceId);
    if (!store) {
      store = new TiddlyWebSyncStateStore(workspaceId);
      await store.load();
      this.stateStores.set(workspaceId, store);
    }
    return store;
  }

  private getProgressSubject(workspaceId: string): Subject<TiddlyWebSyncProgressEvent> {
    let subject = this.progressSubjects.get(workspaceId);
    if (!subject) {
      subject = new Subject<TiddlyWebSyncProgressEvent>();
      this.progressSubjects.set(workspaceId, subject);
    }
    return subject;
  }
}
