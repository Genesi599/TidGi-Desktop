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

/**
 * Maximum number of actions to process concurrently. The TiddlyWiki NodeJS
 * server is comfortable with modest parallelism (it serialises writes to the
 * same tiddler internally), and the local wiki worker serialises its own IPC
 * anyway — so raising this from 1 mostly wins on HTTP round-trip latency.
 * 8 keeps a fresh-clone-of-20k-tiddlers pass under a few minutes without
 * noticeably stressing the server.
 */
const APPLY_CONCURRENCY = 8;

/**
 * Convert a raw tiddler fields object (as returned by TW's `getTiddler().fields`)
 * to the wire format. Two normalisations:
 *   - `tags` array → TW string format `[[tag with space]] tag2 tag3`.
 *   - Stringify any non-string scalar fields so the hash function and HTTP
 *     body always see plain strings.
 */
function normaliseLocalFields(raw: Record<string, unknown>): TiddlerFields {
  const out: TiddlerFields = { title: '' };
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    if (key === 'tags' && Array.isArray(value)) {
      out.tags = (value as string[])
        .map((tag) => (tag.includes(' ') ? `[[${tag}]]` : tag))
        .join(' ');
    } else if (typeof value === 'string') {
      out[key] = value;
    } else if (value instanceof Date) {
      // TW stores dates as YYYYMMDDHHMMSSmmm; if we get a Date object, format it.
      out[key] = stringifyTwDate(value);
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

function stringifyTwDate(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    d.getUTCFullYear().toString().padStart(4, '0') +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    pad(d.getUTCMilliseconds(), 3)
  );
}

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

  public async testServerAdHoc(
    baseUrl: string,
    recipe: string,
    username: string,
    password: string,
  ): Promise<TiddlyWebConnectionResult> {
    try {
      const trimmedUrl = baseUrl.trim().replace(/\/+$/, '');
      if (trimmedUrl.length === 0) {
        return { reachable: false, error: 'URL is empty' };
      }
      const client = new TiddlyWebClient({
        baseUrl: trimmedUrl,
        recipe: recipe.trim().length > 0 ? recipe.trim() : 'default',
        username: username.trim(),
        password,
      });
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

  /**
   * Pre-populate sync state from an HTML-snapshot import so the subsequent
   * first sync can skip re-downloading tiddlers we already have on disk.
   *
   * Rationale: the TiddlyWeb clone flow downloads a server HTML snapshot,
   * extracts ~18k tiddlers into `tiddlers/`, then registers the workspace
   * and fires a first sync. Without seeding, reconcile() sees `L && R && !S`
   * for every tiddler and emits `pull-with-backupLocal` → one HTTP GET per
   * tiddler → minutes of wasted traffic to re-fetch byte-identical content.
   *
   * How seeding works:
   *   1. Caller extracts `(title, revision, bag)` triples from the snapshot
   *      files and passes them here.
   *   2. We write entries flagged `fromSnapshot: true` with a placeholder
   *      empty hash. (We don't know the hash yet — the definitive hash
   *      depends on TW's add/readTiddler round-trip, and the wiki hasn't
   *      started. So we defer hash recording to the first runSync.)
   *   3. On the very next `runSync`, the pre-reconcile graduation loop fills
   *      in each seeded entry's `lastSyncedLocalHash` from the live local
   *      map and clears `fromSnapshot`. Reconciler then sees matching hash
   *      + matching revision → skip.
   *
   * Idempotence: existing entries are NOT overwritten. If a user somehow
   * re-imports a snapshot over an already-synced workspace, their real sync
   * history wins.
   *
   * Fingerprint: we proactively set the store fingerprint to match what the
   * first sync will compute, so `ensureFingerprint` during runSync doesn't
   * wipe our seeded entries.
   */
  public async seedSyncState(
    workspaceId: string,
    entries: Array<{ title: string; revision: string; bag?: string }>,
  ): Promise<{ seeded: number }> {
    if (entries.length === 0) return { seeded: 0 };
    const workspace = await this.getWorkspaceIfTiddlyWeb(workspaceId);
    if (!workspace?.tiddlywebUrl) {
      logger.warn('TiddlyWebSync.seedSyncState: workspace not tiddlyweb or missing URL; skipping', { workspaceId });
      return { seeded: 0 };
    }
    const store = await this.getStateStore(workspaceId);
    store.ensureFingerprint(`${workspace.tiddlywebUrl}|${workspace.tiddlywebRecipe ?? 'default'}`);
    const now = Date.now();
    let seeded = 0;
    for (const entry of entries) {
      if (typeof entry.title !== 'string' || entry.title.length === 0) continue;
      if (typeof entry.revision !== 'string' || entry.revision.length === 0) continue;
      // Don't clobber an existing entry — a prior successful sync's data is
      // strictly more authoritative than our snapshot-derived guess.
      if (store.get(entry.title) !== undefined) continue;
      store.upsert({
        title: entry.title,
        lastKnownRemoteRevision: entry.revision,
        lastSyncedLocalHash: '',
        lastSyncedAt: now,
        bag: entry.bag,
        fromSnapshot: true,
      });
      seeded += 1;
    }
    await store.save();
    logger.info('TiddlyWebSync.seedSyncState: seeded entries from HTML snapshot', {
      workspaceId,
      seeded,
      provided: entries.length,
    });
    return { seeded };
  }

  /**
   * Release every per-workspace resource this service holds.
   *
   * Called from the workspace-removal flow. If we skip this, each of the four
   * maps below keeps the workspace entry forever:
   *   - `inFlight`        — a live Promise that will try to call
   *                         `wikiOperationInServer` on an id that no longer
   *                         exists (spams errors in the log)
   *   - `progressSubjects` — unsubscribed Observable stays hot
   *   - `stateStores`      — ~MB-scale tiddler map pinned in memory
   *   - `lastErrors`       — trivial but still a leak
   *
   * Completing the in-flight promise (rather than cancelling it — we have no
   * AbortSignal plumbed through the client) is best-effort: we just let it
   * resolve naturally before dropping the map entry. Most callers await this
   * method with a short timeout; if the sync takes longer, we drop the entry
   * anyway and the trailing IO will fail harmlessly against a dead worker.
   */
  public async cleanupWorkspace(workspaceId: string): Promise<void> {
    const inFlight = this.inFlight.get(workspaceId);
    if (inFlight !== undefined) {
      try {
        // Cap the wait so a stuck sync can't block workspace removal forever.
        await Promise.race([
          inFlight.catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      } catch {
        // Already caught above; this catch is just belt-and-braces.
      }
    }
    this.inFlight.delete(workspaceId);
    const progressSubject = this.progressSubjects.get(workspaceId);
    if (progressSubject !== undefined) {
      progressSubject.complete();
      this.progressSubjects.delete(workspaceId);
    }
    this.stateStores.delete(workspaceId);
    this.lastErrors.delete(workspaceId);
    logger.info('TiddlyWebSync: workspace state cleared', { workspaceId });
  }

  public async cleanupConflictBackups(workspaceId: string): Promise<{ deleted: number }> {
    const workspace = await this.getWorkspaceIfTiddlyWeb(workspaceId);
    if (!workspace) return { deleted: 0 };
    const wikiService = container.get<IWikiService>(serviceIdentifier.Wiki);
    // Use getTiddlersAsJson with a prefix filter to enumerate conflict backups.
    const result = await wikiService.wikiOperationInServer(
      WikiChannel.getTiddlersAsJson,
      workspaceId,
      [`[prefix[${CONFLICT_BACKUP_PREFIX}]]`],
    );
    if (!Array.isArray(result)) return { deleted: 0 };
    let deleted = 0;
    for (const raw of result as Array<Record<string, unknown>>) {
      const title = raw.title;
      if (typeof title !== 'string') continue;
      try {
        await wikiService.wikiOperationInServer(WikiChannel.deleteTiddler, workspaceId, [title]);
        deleted += 1;
      } catch (error) {
        logger.warn('TiddlyWebSync: cleanupConflictBackups failed for tiddler', { workspaceId, title, error });
      }
    }
    logger.info('TiddlyWebSync: conflict backups cleaned up', { workspaceId, deleted });
    return { deleted };
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

      // ── 2.5. Triage snapshot-seeded state entries ────────────────────
      // HTML-snapshot seeding wrote entries with `fromSnapshot: true` and
      // an empty hash placeholder. Now that we've read both the live local
      // store and the server's tiddler listing, we split those seeded
      // entries into two groups based on whether the server actually lists
      // the title:
      //
      //   (a) Confirmed — server lists the title. Fill in the authoritative
      //       local hash and clear `fromSnapshot`. Reconciler then sees
      //       matching hash + matching revision and skips — no redundant
      //       pull of the tens of thousands of tiddlers we already got
      //       from the snapshot.
      //
      //   (b) Orphan — server does NOT list the title. This is by far the
      //       common case for plugin / theme / system tiddlers: the server
      //       materialises them in-page (so they appeared in the snapshot
      //       HTML) but its recipe doesn't expose them over HTTP. CRITICAL:
      //       we must NOT let the reconciler run its normal logic on these
      //       entries — with `L && !R && S && L.hash === S.lastSyncedLocalHash`
      //       it would emit `delete-local` for every one of them, wiping
      //       the 18k snapshot files on first sync and leaving the user's
      //       wiki as a blank template on next restart. Instead: record
      //       the live local hash but KEEP `fromSnapshot: true`. The
      //       reconciler has a dedicated short-circuit for this flag that
      //       emits no action — the local file stays, the server stays,
      //       and the entry continues to suppress sync churn on every
      //       subsequent run. If the server ever starts listing the title,
      //       that later sync's graduation step lands it in branch (a).
      let graduatedFromSnapshot = 0;
      let snapshotOrphans = 0;
      for (const [title, entry] of store.all()) {
        if (entry.fromSnapshot !== true) continue;
        const L = local.get(title);
        if (remote.has(title)) {
          store.upsert({
            ...entry,
            fromSnapshot: false,
            lastSyncedLocalHash: L?.hash ?? '',
          });
          graduatedFromSnapshot += 1;
        } else {
          store.upsert({
            ...entry,
            // fromSnapshot intentionally left true — see branch (b) above.
            lastSyncedLocalHash: L?.hash ?? '',
          });
          snapshotOrphans += 1;
        }
      }
      if (graduatedFromSnapshot > 0 || snapshotOrphans > 0) {
        logger.info('TiddlyWebSync: triaged snapshot-seeded entries', {
          workspaceId,
          graduatedFromSnapshot,
          snapshotOrphans,
        });
      }

      // ── 3. Reconcile ──────────────────────────────────────────────────
      const actions = reconcile({ local, remote, syncState: store.all() });
      const summary = summarise(actions);
      progress.next({ phase: 'reconciled', workspaceId, summary });
      logger.info('TiddlyWebSync: reconciled', { workspaceId, summary });

      // ── 4. Apply actions (bounded concurrency) ───────────────────────
      // Safety: each action operates on a distinct tiddler title, so the
      // shared store / localFieldsByTitle / progress subject are all
      // concurrency-safe under JS's single-threaded event loop.
      //
      // Performance notes:
      //   - CHECKPOINT_EVERY=5000: state.save() JSON.stringifies the whole
      //     Map and does an atomic temp+rename write. On a 20k-tiddler pass,
      //     saving every 500 items means 40 writes of a Map that grows by
      //     the same amount each time — O(N²) disk I/O. 5000 shrinks this
      //     to 4 writes; the fresh checkpoint on finish still guarantees
      //     we never lose more than ~5000 items' progress to a crash.
      //   - Progress events are throttled (see PROGRESS_MIN_INTERVAL_MS).
      //     Otherwise we'd emit 20000 RxJS events → 20000 IPC hops to the
      //     renderer → 20000 React re-renders, which noticeably chokes the
      //     UI and adds its own O(N) tail to sync time.
      const CHECKPOINT_EVERY = 5000;
      const PROGRESS_MIN_INTERVAL_MS = 200;
      const errors: TiddlyWebSyncResult['errors'] = [];
      let completed = 0;
      let nextIndex = 0;
      let lastCheckpoint = 0;
      let lastProgressAt = 0;
      let checkpointInFlight: Promise<void> | undefined;
      const workerCount = Math.min(APPLY_CONCURRENCY, actions.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
          const idx = nextIndex++;
          if (idx >= actions.length) return;
          const action = actions[idx];
          // Throttle progress events — we don't need one per tiddler.
          // Always emit the very first one (so the UI updates promptly from
          // 'reconciled' into 'applying 1/N').
          const now = Date.now();
          if (idx === 0 || now - lastProgressAt >= PROGRESS_MIN_INTERVAL_MS) {
            lastProgressAt = now;
            progress.next({
              phase: 'applying',
              workspaceId,
              completed,
              total: actions.length,
              currentTitle: 'title' in action ? action.title : undefined,
            });
          }
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
          if (completed - lastCheckpoint >= CHECKPOINT_EVERY && checkpointInFlight === undefined) {
            lastCheckpoint = completed;
            checkpointInFlight = store.save().catch((error) => {
              logger.warn('TiddlyWebSync: checkpoint save failed', { workspaceId, error });
            }).finally(() => {
              checkpointInFlight = undefined;
            });
          }
        }
      });
      await Promise.all(workers);
      // Make sure any in-flight checkpoint finishes before we move to the
      // final save, to avoid overlapping disk writes.
      if (checkpointInFlight) {
        await checkpointInFlight;
      }
      // Emit one final applying event so the UI shows the last-processed
      // item's number even if the throttle skipped it.
      progress.next({
        phase: 'applying',
        workspaceId,
        completed,
        total: actions.length,
      });

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
    const remoteFields = await client.fetchOne(action.title);
    // The reconciler flagged this as a conflict based on local-hash-vs-state
    // and remote-revision-vs-state mismatches. But both can drift spuriously:
    //   - server revisions can bump when .tid files are re-read on server restart,
    //   - local hashes can shift if a write-roundtrip through TW's addTiddler
    //     changes anything outside our METADATA_FIELDS.
    // Before writing a backup tiddler (which creates a NEW local title and
    // therefore visible clutter that grows every sync), confirm local and
    // remote content genuinely differ by comparing their hashes directly.
    // If they're identical we silently update state and move on — no backup
    // noise, no per-sync accumulation of `$:/sync/conflicts/*`.
    const realConflict = local !== undefined
      && computeTiddlerHash(local) !== computeTiddlerHash(remoteFields);
    if (realConflict) {
      await this.writeConflictBackup(action.title, local!, wikiService, workspaceId);
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

  // ────────────────────────────────────────────────────────────────────────
  // Local store I/O helpers
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Snapshot local tiddlers, applying the user's exclude filter.
   *
   * We write the exclude expression to a temp tiddler and reference it via
   * `subfilter{...}`, because TW's filter operand `[]` syntax can't carry
   * arbitrary user input safely (closing brackets break it).
   *
   * The custom `getTiddlersAsJson` operation in TidGi returns raw `tiddler.fields`
   * where `tags` is a JS array. The TiddlyWeb wire format uses a string of
   * space-separated `[[tag]]` entries, and so does the rest of our pipeline
   * (hash function, push body). We normalise here so downstream code only ever
   * sees strings.
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
    return (result as Array<Record<string, unknown>>).map((raw) => normaliseLocalFields(raw));
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
