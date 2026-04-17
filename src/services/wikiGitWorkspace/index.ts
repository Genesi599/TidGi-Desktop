import { app, dialog, powerMonitor } from 'electron';
import { copy, pathExists, remove } from 'fs-extra';
import { inject, injectable } from 'inversify';
import path from 'path';

import type { IAuthenticationService } from '@services/auth/interface';
import { container } from '@services/container';
import type { IGitService, IGitUserInfos } from '@services/git/interface';
import type { INotificationService } from '@services/notifications/interface';
import serviceIdentifier from '@services/serviceIdentifier';
import type { IWikiService } from '@services/wiki/interface';
import type { IWindowService } from '@services/windows/interface';
import { WindowNames } from '@services/windows/WindowProperties';
import type { INewWikiWorkspaceConfig, IWorkspace, IWorkspaceService } from '@services/workspaces/interface';
import { isWikiWorkspace } from '@services/workspaces/interface';
import type { IWorkspaceViewService } from '@services/workspacesView/interface';

// Import from appPaths to get the Electron-accurate Desktop path (handles OneDrive Desktop redirect)
import { DEFAULT_FIRST_WIKI_FOLDER_PATH, DEFAULT_FIRST_WIKI_PATH } from '@/constants/appPaths';
import type { IContextService } from '@services/context/interface';
import { i18n } from '@services/libs/i18n';
import { logger } from '@services/libs/log';
import type { ISyncService } from '@services/sync/interface';
import type { ITiddlyWebSyncService } from '@services/tiddlywebSync/interface';
import { SupportedStorageServices } from '@services/types';
import { updateGhConfig } from '@services/wiki/plugin/ghPages';
import { hasGit } from 'git-sync-js';
import { InitWikiGitError, InitWikiGitRevertError, InitWikiGitSyncedWikiNoGitUserInfoError } from './error';
import type { IWikiGitWorkspaceService } from './interface';

@injectable()
export class WikiGitWorkspace implements IWikiGitWorkspaceService {
  constructor(
    @inject(serviceIdentifier.Authentication) private readonly authService: IAuthenticationService,
    @inject(serviceIdentifier.Context) private readonly contextService: IContextService,
    @inject(serviceIdentifier.NotificationService) private readonly notificationService: INotificationService,
  ) {
  }

  public registerSyncBeforeShutdown(): void {
    const listener = async (): Promise<void> => {
      try {
        if (await this.contextService.isOnline()) {
          const workspaceService = container.get<IWorkspaceService>(serviceIdentifier.Workspace);
          const workspaces = await workspaceService.getWorkspacesAsList();
          const workspacesToSync = workspaces.filter((workspace) =>
            isWikiWorkspace(workspace) &&
            workspace.storageService !== SupportedStorageServices.local &&
            !workspace.hibernated
          );
          await Promise.allSettled([
            this.notificationService.show({ title: i18n.t('Preference.SyncBeforeShutdown') }),
            ...workspacesToSync.map(async (workspace) => {
              if (!isWikiWorkspace(workspace)) return;
              if (workspace.readOnlyMode) {
                return;
              }
              await container.get<ISyncService>(serviceIdentifier.Sync).syncWikiIfNeeded(workspace);
            }),
          ]);
        }
      } catch (error_: unknown) {
        const error = error_ as Error;
        logger.error(`SyncBeforeShutdown failed`, { error });
      } finally {
        app.quit();
      }
    };
    // only on linux,darwin, and can't prevent default
    powerMonitor.addListener('shutdown', listener);
  }

  public initWikiGitTransaction = async (newWorkspaceConfig: INewWikiWorkspaceConfig, userInfo?: IGitUserInfos): Promise<IWorkspace | undefined> => {
    const workspaceService = container.get<IWorkspaceService>(serviceIdentifier.Workspace);
    const newWorkspace = await workspaceService.create(newWorkspaceConfig);
    if (!isWikiWorkspace(newWorkspace)) {
      throw new Error('initWikiGitTransaction can only be called with wiki workspaces');
    }
    const { gitUrl, storageService, wikiFolderLocation, isSubWiki, id: workspaceID, mainWikiToLink } = newWorkspace;
    try {
      const previousActiveId = workspaceService.getActiveWorkspaceSync()?.id;
      await workspaceService.setActiveWorkspace(newWorkspace.id, previousActiveId);
      // From git's perspective, tiddlyweb is local-only: its sync runs over
      // the TiddlyWeb HTTP API, not git. We only take the "remote git" branch
      // for actual git-backed providers (github/gitlab/codeberg/gitea/testOAuth).
      const isSyncedViaGit = storageService !== SupportedStorageServices.local
        && storageService !== SupportedStorageServices.tiddlyweb;
      // TiddlyWeb sync doesn't use git at all — `sync/index.ts` routes tiddlyweb
      // workspaces to `TiddlyWebSync.syncWorkspace` and never touches
      // `gitService.commitAndSync`. Skip `initWikiGit` entirely here: on a
      // full-mirror clone the preceding snapshot import drops ~19k tiddler
      // files into the folder, and `git-sync-js`'s `initGit` does an
      // unconditional `git add . && git commit` (labelled "Initial Commit
      // with Git-Sync-JS") that takes 20–60s on Windows NTFS before the wiki
      // worker can even boot. Users who want local git history can opt in
      // later from Edit Workspace.
      if (storageService === SupportedStorageServices.tiddlyweb) {
        logger.info('Skip git init for tiddlyweb workspace (syncs over HTTP, not git).', { wikiFolderLocation, workspaceID });
      } else if (await hasGit(wikiFolderLocation)) {
        logger.warn('Skip git init because it already has a git setup.', { wikiFolderLocation });
      } else if (isSyncedViaGit) {
        if (typeof gitUrl === 'string' && userInfo !== undefined) {
          const gitService = container.get<IGitService>(serviceIdentifier.Git);
          await gitService.initWikiGit(wikiFolderLocation, isSyncedViaGit, !isSubWiki, gitUrl, userInfo);
          const authService = container.get<IAuthenticationService>(serviceIdentifier.Authentication);
          const branch = await authService.get(`${storageService}-branch`);
          if (branch !== undefined) {
            await updateGhConfig(wikiFolderLocation, { branch });
          }
        } else {
          throw new InitWikiGitSyncedWikiNoGitUserInfoError(gitUrl, userInfo);
        }
      } else {
        const gitService = container.get<IGitService>(serviceIdentifier.Git);
        await gitService.initWikiGit(wikiFolderLocation, false);
      }
      return newWorkspace;
    } catch (error_: unknown) {
      // prepare to rollback changes
      const error = error_ as Error;
      const errorMessage = `initWikiGitTransaction failed, ${error.message} ${error.stack ?? ''}`;
      logger.error(errorMessage);
      const workspaceService = container.get<IWorkspaceService>(serviceIdentifier.Workspace);
      const wikiService = container.get<IWikiService>(serviceIdentifier.Wiki);
      await workspaceService.remove(workspaceID);
      try {
        if (!isSubWiki) {
          await wikiService.removeWiki(wikiFolderLocation);
        } else if (typeof mainWikiToLink === 'string') {
          await wikiService.removeWiki(wikiFolderLocation, mainWikiToLink);
        }
      } catch (error_: unknown) {
        throw new InitWikiGitRevertError(String(error_));
      }
      throw new InitWikiGitError(errorMessage);
    }
  };

  /**
   * Automatically initialize a default wiki workspace if none exists. This matches the previous frontend logic.
   */
  public async initialize(): Promise<void> {
    logger.info('checking for default wiki workspace', { function: 'WikiGitWorkspace.initialize' });
    const workspaceService = container.get<IWorkspaceService>(serviceIdentifier.Workspace);
    const workspaces = await workspaceService.getWorkspacesAsList();
    const wikiWorkspaces = workspaces.filter(w => isWikiWorkspace(w) && !w.isSubWiki);
    logger.info(`Found ${wikiWorkspaces.length} existing wiki workspaces`, {
      wikiWorkspaces: wikiWorkspaces.map(w => w.id),
      function: 'WikiGitWorkspace.initialize',
    });
    if (wikiWorkspaces.length > 0) {
      logger.info('Skipping default workspace creation - workspaces already exist', {
        function: 'WikiGitWorkspace.initialize',
      });
      return;
    }
    // Construct minimal default config, only fill required fields, let workspaceService.create handle defaults
    const defaultConfig: INewWikiWorkspaceConfig = {
      order: 0,
      wikiFolderLocation: DEFAULT_FIRST_WIKI_PATH,
      storageService: SupportedStorageServices.local,
      name: 'wiki',
      port: 5212,
      isSubWiki: false,
      backupOnInterval: true,
      readOnlyMode: false,
      tokenAuth: false,
      tagNames: [],
      mainWikiToLink: null,
      mainWikiID: null,
      excludedPlugins: [],
      enableHTTPAPI: false,
      enableFileSystemWatch: false,
      includeTagTree: false,
      fileSystemPathFilterEnable: false,
      fileSystemPathFilter: null,
      lastNodeJSArgv: [],
      homeUrl: '',
      gitUrl: null,
    };
    try {
      logger.info('Starting default wiki creation', {
        config: {
          name: defaultConfig.name,
          port: defaultConfig.port,
          path: defaultConfig.wikiFolderLocation,
        },
        function: 'WikiGitWorkspace.initialize',
      });
      // Copy the wiki template first
      logger.info('Copying wiki template...', {
        from: 'TIDDLYWIKI_TEMPLATE_FOLDER',
        to: DEFAULT_FIRST_WIKI_PATH,
        function: 'WikiGitWorkspace.initialize',
      });
      const wikiService = container.get<IWikiService>(serviceIdentifier.Wiki);
      await wikiService.copyWikiTemplate(DEFAULT_FIRST_WIKI_FOLDER_PATH, 'wiki');
      logger.info('Wiki template copied successfully', {
        path: DEFAULT_FIRST_WIKI_PATH,
        function: 'WikiGitWorkspace.initialize',
      });
      // Create the workspace
      logger.info('Initializing wiki git transaction...', {
        function: 'WikiGitWorkspace.initialize',
      });
      await this.initWikiGitTransaction(defaultConfig);
      logger.info('Default wiki workspace created successfully', {
        function: 'WikiGitWorkspace.initialize',
      });
    } catch (error_: unknown) {
      const error = error_ as Error;
      logger.error('Failed to create default wiki workspace', {
        error,
        function: 'WikiGitWorkspace.initialize',
      });
    }
  }

  public async removeWorkspace(workspaceID: string): Promise<void> {
    const mainWindow = container.get<IWindowService>(serviceIdentifier.Window).get(WindowNames.main);
    if (mainWindow === undefined) {
      return;
    }
    const workspaceService = container.get<IWorkspaceService>(serviceIdentifier.Workspace);
    const workspace = await workspaceService.get(workspaceID);
    if (workspace === undefined) {
      throw new Error(`Need to get workspace with id ${workspaceID} but failed`);
    }
    if (!isWikiWorkspace(workspace)) {
      throw new Error('removeWikiGitTransaction can only be called with wiki workspaces');
    }
    const { isSubWiki, mainWikiToLink, wikiFolderLocation, id, name, storageService } = workspace;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: [i18n.t('WorkspaceSelector.RemoveWorkspace'), i18n.t('WorkspaceSelector.RemoveWorkspaceAndDelete'), i18n.t('Cancel')],
      message: `${i18n.t('EditWorkspace.Name')} ${name} ${isSubWiki ? i18n.t('EditWorkspace.IsSubWorkspace') : ''} ${i18n.t('WorkspaceSelector.AreYouSure')}`,
      cancelId: 2,
    });
    const removeWorkspaceAndDelete = response === 1;
    const onlyRemoveWorkspace = response === 0;
    if (!onlyRemoveWorkspace && !removeWorkspaceAndDelete) {
      return;
    }

    const wikiService = container.get<IWikiService>(serviceIdentifier.Wiki);
    logger.info('removeWorkspace: begin', { function: 'removeWorkspace', workspaceID, storageService, isSubWiki, removeWorkspaceAndDelete });

    // ── 1. Recursively remove sub-wikis (main wiki only). Do this FIRST so a
    //       failing sub-removal can't leave us in a half-removed state where
    //       the main wiki is gone from the DB but its subs still reference it.
    //       Each sub-removal is best-effort; one failure doesn't abort the
    //       others or the main removal.
    if (!isSubWiki) {
      const subWikis = workspaceService.getSubWorkspacesAsListSync(id);
      if (subWikis.length > 0) {
        logger.info('removeWorkspace: removing sub-wikis', { function: 'removeWorkspace', workspaceID, subCount: subWikis.length });
        await Promise.all(subWikis.map(async (subWiki) => {
          try {
            await this.removeWorkspace(subWiki.id);
          } catch (error) {
            logger.error('removeWorkspace: sub-wiki removal failed', { function: 'removeWorkspace', workspaceID, subWikiID: subWiki.id, error });
          }
        }));
      }
    }

    // ── 2. Stop the wiki worker. Has its own internal timeout (5s on
    //       beforeExit), but wrap again here so even a catastrophic throw
    //       can't block the DB removal below.
    try {
      await wikiService.stopWiki(id);
    } catch (error) {
      logger.error('removeWorkspace: stopWiki failed', { function: 'removeWorkspace', workspaceID, error });
    }

    // ── 3. TiddlyWeb-specific state cleanup. The TiddlyWebSync service keeps
    //       per-workspace Maps (inFlight, progress subject, state store cache,
    //       last error) that stopWiki doesn't touch. Without this the Maps
    //       grow monotonically across workspace removals and, worse, an
    //       in-flight sync keeps trying to call wikiOperationInServer on a
    //       removed workspace.
    if (storageService === SupportedStorageServices.tiddlyweb) {
      try {
        const tiddlyWebSync = container.get<ITiddlyWebSyncService>(serviceIdentifier.TiddlyWebSync);
        await tiddlyWebSync.cleanupWorkspace(id);
      } catch (error) {
        logger.error('removeWorkspace: tiddlyWebSync.cleanupWorkspace failed', { function: 'removeWorkspace', workspaceID, error });
      }
    }

    // ── 4. Remove from the database FIRST, before touching views or files.
    //       This is the primary user intent — "I want the workspace gone from
    //       my sidebar". Previously this ran last, so any prior failure (view
    //       teardown, file deletion, etc) would silently abort removal and
    //       leave the workspace stuck in the sidebar. Keep it early and
    //       unconditional so the UI always reflects the user's choice.
    try {
      await workspaceService.remove(workspaceID);
      logger.info('removeWorkspace: DB entry removed', { function: 'removeWorkspace', workspaceID });
    } catch (error) {
      logger.error('removeWorkspace: workspaceService.remove failed', { function: 'removeWorkspace', workspaceID, error });
      // If we can't remove from the DB there's no point continuing — sidebar
      // won't update and further teardown would desynchronise state.
      return;
    }

    // ── 5. Destroy the BrowserView(s) for this workspace. Failure here is
    //       cosmetic (view stays rendered until next restart) and must not
    //       revert the DB removal.
    try {
      await container.get<IWorkspaceViewService>(serviceIdentifier.WorkspaceView).removeWorkspaceView(workspaceID);
    } catch (error) {
      logger.error('removeWorkspace: removeWorkspaceView failed', { function: 'removeWorkspace', workspaceID, error });
    }

    // ── 6. Optionally delete files on disk. Done AFTER stopWiki+DB-remove so
    //       all file handles are closed and the workspace is already gone
    //       from the user's perspective even if trashItem fails (e.g.
    //       Windows file-lock contention).
    if (removeWorkspaceAndDelete) {
      try {
        if (isSubWiki) {
          if (mainWikiToLink === null) {
            throw new Error(`workspace.mainWikiToLink is null in WikiGitWorkspace.removeWorkspace ${JSON.stringify(workspace)}`);
          }
          await wikiService.removeWiki(wikiFolderLocation, mainWikiToLink, onlyRemoveWorkspace);
        } else {
          await wikiService.removeWiki(wikiFolderLocation);
        }
      } catch (error) {
        logger.error('removeWorkspace: removeWiki (file deletion) failed', { function: 'removeWorkspace', workspaceID, wikiFolderLocation, error });
      }
    }

    // ── 7. Switch active view to the first remaining workspace. Best-effort.
    try {
      const firstWorkspace = await workspaceService.getFirstWorkspace();
      if (firstWorkspace !== undefined) {
        await container.get<IWorkspaceViewService>(serviceIdentifier.WorkspaceView).setActiveWorkspaceView(firstWorkspace.id);
      }
    } catch (error) {
      logger.error('removeWorkspace: setActiveWorkspaceView failed', { function: 'removeWorkspace', workspaceID, error });
    }

    logger.info('removeWorkspace: done', { function: 'removeWorkspace', workspaceID });
  }

  public async moveWorkspaceLocation(workspaceID: string, newParentLocation: string): Promise<void> {
    const workspaceService = container.get<IWorkspaceService>(serviceIdentifier.Workspace);
    const workspace = await workspaceService.get(workspaceID);
    if (workspace === undefined) {
      throw new Error(`Need to get workspace with id ${workspaceID} but failed`);
    }
    if (!isWikiWorkspace(workspace)) {
      throw new Error('moveWorkspaceLocation can only be called with wiki workspaces');
    }

    const { wikiFolderLocation, name } = workspace;
    const wikiFolderName = path.basename(wikiFolderLocation);
    const newWikiFolderLocation = path.join(newParentLocation, wikiFolderName);

    if (!(await pathExists(wikiFolderLocation))) {
      throw new Error(`Source wiki folder does not exist: ${wikiFolderLocation}`);
    }
    if (await pathExists(newWikiFolderLocation)) {
      throw new Error(`Target location already exists: ${newWikiFolderLocation}`);
    }

    try {
      logger.info(`Moving workspace ${name} from ${wikiFolderLocation} to ${newWikiFolderLocation}`);

      const wikiService = container.get<IWikiService>(serviceIdentifier.Wiki);
      await wikiService.stopWiki(workspaceID).catch((error_: unknown) => {
        const error = error_ as Error;
        logger.error(`Failed to stop wiki before move: ${error.message}`, { error });
      });

      await copy(wikiFolderLocation, newWikiFolderLocation, {
        overwrite: false,
        errorOnExist: true,
      });

      await workspaceService.update(workspaceID, {
        wikiFolderLocation: newWikiFolderLocation,
      });

      logger.info(`Successfully moved workspace to ${newWikiFolderLocation} [test-id-WORKSPACE_MOVED:${newWikiFolderLocation}]`);
      // Restart the workspace view to load from new location
      const workspaceViewService = container.get<IWorkspaceViewService>(serviceIdentifier.WorkspaceView);
      await workspaceViewService.restartWorkspaceViewService(workspaceID);

      logger.debug(`Workspace view restarted after move [test-id-WORKSPACE_RESTARTED_AFTER_MOVE:${workspaceID}]`);
      // Only delete old folder after successful restart to avoid inconsistent state
      await remove(wikiFolderLocation);
    } catch (error_: unknown) {
      const error = error_ as Error;
      logger.error(`Failed to move workspace: ${error.message}`, { error });
      throw error;
    }
  }
}
