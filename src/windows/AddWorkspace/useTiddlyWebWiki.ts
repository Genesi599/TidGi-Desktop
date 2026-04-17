/**
 * Hooks for the "Clone from TiddlyWiki NodeJS Server" tab.
 *
 * Flow on submit (emitted as `TiddlyWebCloneStage` transitions so the
 * progress dialog can render each step distinctly):
 *   1. `copyingTemplate`        → copyWikiTemplate
 *   2. `clearingTiddlers`       → emptyWikiTiddlersFolder (prevent template
 *                                 leaking to server on first push)
 *   3. `downloadingSnapshot`    → importTiddlersFromHtmlUrl (non-fatal;
 *                                 gives us plugin/theme fidelity that the
 *                                 TiddlyWeb REST API can't provide)
 *   4. `registeringWorkspace`   → initWikiGitTransaction (DB record)
 *   5. `startingWiki`           → initializeWorkspaceView + setActive
 *   6. `firstSync`              → main-process auto-fires first sync; the
 *                                 dialog subscribes to tiddlyWebSync.progress$
 *                                 to render listing / applying / finished
 *   7. `done`                   → user dismisses, window closes
 *
 * Password is written to the OS keychain BEFORE stage 1 so the main-process
 * auto-sync in stage 6 can read it without a race.
 */
import { WikiCreationMethod } from '@/constants/wikiCreation';
import { FILTER_PRESET_FULL_MIRROR } from '@services/tiddlywebSync/filterPresets';
import { SupportedStorageServices } from '@services/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callWikiInitialization } from './useCallWikiInitialization';
import type { ITiddlyWebWikiFormValues } from './TiddlyWebWikiForm';
import type { TiddlyWebCloneState } from './TiddlyWebCloneProgressDialog';
import type { IErrorInWhichComponent, IWikiWorkspaceForm } from './useForm';
import { workspaceConfigFromForm } from './useForm';

export function useValidateTiddlyWebWiki(
  form: IWikiWorkspaceForm,
  tiddlywebForm: ITiddlyWebWikiFormValues,
  errorInWhichComponentSetter: (errors: IErrorInWhichComponent) => void,
): [boolean, string | undefined, (m: string) => void, (m: boolean) => void] {
  const { t } = useTranslation();
  const [wikiCreationMessage, wikiCreationMessageSetter] = useState<string | undefined>();
  const [hasError, hasErrorSetter] = useState<boolean>(false);
  useEffect(() => {
    if (!form.parentFolderLocation) {
      wikiCreationMessageSetter(`${t('AddWorkspace.NotFilled')}：${t('AddWorkspace.WorkspaceFolder')}`);
      errorInWhichComponentSetter({ parentFolderLocation: true });
      hasErrorSetter(true);
    } else if (!form.wikiFolderName) {
      wikiCreationMessageSetter(`${t('AddWorkspace.NotFilled')}：${t('AddWorkspace.WorkspaceFolderNameToCreate')}`);
      errorInWhichComponentSetter({ wikiFolderName: true });
      hasErrorSetter(true);
    } else if (!tiddlywebForm.url.trim()) {
      wikiCreationMessageSetter(`${t('AddWorkspace.NotFilled')}：${t('AddWorkspace.TiddlyWebCloneUrl')}`);
      errorInWhichComponentSetter({});
      hasErrorSetter(true);
    } else if (!tiddlywebForm.recipe.trim()) {
      wikiCreationMessageSetter(`${t('AddWorkspace.NotFilled')}：${t('AddWorkspace.TiddlyWebCloneRecipe')}`);
      errorInWhichComponentSetter({});
      hasErrorSetter(true);
    } else {
      wikiCreationMessageSetter('');
      errorInWhichComponentSetter({});
      hasErrorSetter(false);
    }
  }, [
    t,
    form.parentFolderLocation,
    form.wikiFolderName,
    tiddlywebForm.url,
    tiddlywebForm.recipe,
    errorInWhichComponentSetter,
  ]);
  return [hasError, wikiCreationMessage, wikiCreationMessageSetter, hasErrorSetter];
}

export interface UseTiddlyWebWikiResult {
  /** Current renderer-side state; fed into the progress dialog. */
  state: TiddlyWebCloneState;
  /** Fire the clone pipeline. Safe to call once — subsequent calls are no-ops. */
  start: () => Promise<void>;
  /**
   * Reset stage back to idle. Used when the user dismisses the progress dialog
   * after a successful clone so the submit button re-enables.
   */
  reset: () => void;
}

export function useTiddlyWebWiki(
  form: IWikiWorkspaceForm,
  tiddlywebForm: ITiddlyWebWikiFormValues,
  wikiCreationMessageSetter: (m: string) => void,
  hasErrorSetter: (m: boolean) => void,
): UseTiddlyWebWikiResult {
  const { t } = useTranslation();
  const [state, setState] = useState<TiddlyWebCloneState>({ stage: 'idle' });
  // Guard against double-click / StrictMode double-invocation resulting in
  // two parallel clone pipelines racing on the same folder.
  const runningRef = useRef(false);

  const reset = useCallback(() => {
    setState({ stage: 'idle' });
    runningRef.current = false;
  }, []);

  const start = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    wikiCreationMessageSetter(t('AddWorkspace.Processing'));
    hasErrorSetter(false);
    setState({ stage: 'copyingTemplate' });

    try {
      // Build config. TiddlyWeb clone is always a main (not sub) workspace in the
      // synced mode; we override storageService + fill tiddlyweb* fields.
      const baseConfig = workspaceConfigFromForm(
        { ...form, storageProvider: SupportedStorageServices.tiddlyweb },
        true, // isCreateMainWorkspace
        true, // isCreateSyncedWorkspace
      );
      const newWorkspaceConfig = {
        ...baseConfig,
        gitUrl: null,
        storageService: SupportedStorageServices.tiddlyweb,
        tiddlywebUrl: tiddlywebForm.url.trim().replace(/\/$/, ''),
        tiddlywebRecipe: tiddlywebForm.recipe.trim(),
        tiddlywebUsername: tiddlywebForm.username.trim(),
        // Cloning from a TW server presupposes "make local look like remote",
        // so default to full-mirror semantics: pull every tiddler the server
        // exposes, including system tiddlers. The user can narrow this later
        // via the preset chips in Edit Workspace. (Safe because we've just
        // emptied the local tiddlers/ folder, so there's nothing template-ish
        // to accidentally push back to the server on first sync.)
        tiddlywebExcludeFilter: FILTER_PRESET_FULL_MIRROR,
      };

      // Password lives in the OS keychain, not the synced workspace config.
      // Persist it BEFORE any other stage so the main-process first sync can
      // read it without racing with the keychain write.
      await window.service.auth.set('tiddlyweb-token', tiddlywebForm.password);

      // ── Stage 1: create empty local wiki folder from template ──────────
      wikiCreationMessageSetter(t('AddWorkspace.TiddlyWebCloneCreatingLocalWiki'));
      await window.service.wiki.copyWikiTemplate(form.parentFolderLocation, form.wikiFolderName);

      // ── Stage 2: clear template tiddlers so they don't pollute remote ──
      // The template ships ~76 .tid/.json files (an Index.tid welcome tiddler
      // plus 12MB of plugin JSON bodies under tiddlers/system/). Without
      // clearing these, the first sync would treat them as new local content
      // and PUSH them to the remote server. tiddlywiki.info, plugins/,
      // public/, scripts/ are untouched — they drive the local wiki boot and
      // never travel over the TiddlyWeb API.
      setState((previous) => ({ ...previous, stage: 'clearingTiddlers' }));
      // Derive the wiki folder location directly — `form.wikiFolderLocation`
      // is typed `string | undefined` because it can be blank until the user
      // picks both the parent folder and the name, but by this point we've
      // already validated both are non-empty.
      const wikiFolderLocation = form.wikiFolderLocation ?? `${form.parentFolderLocation}/${form.wikiFolderName}`;
      await window.service.wiki.emptyWikiTiddlersFolder(wikiFolderLocation);

      // ── Stage 3: import HTML snapshot (non-fatal) ──────────────────────
      // Pull the server's root HTML and extract its embedded tiddlers. The
      // TiddlyWeb REST API only exposes the user bag (no plugin shadows),
      // but the HTML bootstrap contains EVERY tiddler in memory including
      // plugin bodies. This gives us a visually faithful snapshot — the
      // local wiki looks like the server, not like TidGi's default template.
      // Non-fatal: if the server's root isn't an HTML wiki (e.g. nginx
      // rewrite, or proxy to a different endpoint), we log and move on; the
      // subsequent HTTP sync still pulls user content.
      setState((previous) => ({ ...previous, stage: 'downloadingSnapshot' }));
      wikiCreationMessageSetter(t('AddWorkspace.TiddlyWebCloneImportingSnapshot'));
      // Captured out of the try/catch so the later `seedSyncState` call can
      // see it. Stays undefined if the snapshot was skipped / errored —
      // first sync then falls back to pulling everything, which is what it
      // used to do before this optimisation.
      let snapshotSeedEntries: Array<{ title: string; revision: string; bag?: string }> | undefined;
      try {
        const serverRoot = newWorkspaceConfig.tiddlywebUrl + '/';
        const snapshot = await window.service.wiki.importTiddlersFromHtmlUrl(
          wikiFolderLocation,
          serverRoot,
          tiddlywebForm.username.trim(),
          tiddlywebForm.password,
        );
        if (snapshot.errorMessage) {
          void window.service.native.log(
            'warn',
            `TiddlyWeb clone: HTML snapshot skipped — ${snapshot.errorMessage}`,
          );
          setState((previous) => ({ ...previous, snapshotSkipReason: snapshot.errorMessage }));
        } else {
          void window.service.native.log(
            'info',
            `TiddlyWeb clone: HTML snapshot imported ${snapshot.imported} tiddlers`,
          );
          setState((previous) => ({ ...previous, snapshotImported: snapshot.imported }));
          snapshotSeedEntries = snapshot.seedEntries;
        }
      } catch (snapshotError) {
        const message = (snapshotError as Error).message;
        void window.service.native.log('warn', `TiddlyWeb clone: HTML snapshot fetch errored — ${message}`);
        setState((previous) => ({ ...previous, snapshotSkipReason: message }));
      }

      // ── Stage 4 + 5: register workspace, start wiki worker ─────────────
      // We pass `notClose: true` so the AddWorkspace window stays open while
      // the main-process first sync runs; otherwise the window would close
      // immediately and the user wouldn't see the (potentially minute-long)
      // sync progress. The dialog's close button takes care of closing the
      // window once the user is done watching.
      //
      // `onWorkspaceRegistered` runs between `initWikiGitTransaction` and
      // `initializeWorkspaceView`. That window is critical for seeding: the
      // workspace DB row exists (so `seedSyncState` can resolve it), but the
      // wiki worker hasn't booted yet (so the first auto-sync hasn't fired).
      // We await the seed call here — if it returned without completing,
      // runSync would reach `reconcile()` with empty state and pull every
      // tiddler anyway, defeating the whole point.
      setState((previous) => ({ ...previous, stage: 'registeringWorkspace' }));
      wikiCreationMessageSetter(t('AddWorkspace.TiddlyWebCloneInitializing'));
      await callWikiInitialization(
        newWorkspaceConfig,
        wikiCreationMessageSetter,
        t,
        undefined,
        {
          from: WikiCreationMethod.Create,
          notClose: true,
          onWorkspaceRegistered: async (workspace) => {
            // Expose the id ASAP so the dialog can subscribe to progress$
            // before the main-process first sync starts emitting.
            setState((previous) => ({ ...previous, workspaceId: workspace.id, stage: 'startingWiki' }));
            if (snapshotSeedEntries !== undefined && snapshotSeedEntries.length > 0) {
              try {
                const result = await window.service.tiddlyWebSync.seedSyncState(
                  workspace.id,
                  snapshotSeedEntries,
                );
                void window.service.native.log(
                  'info',
                  `TiddlyWeb clone: seeded ${result.seeded} sync-state entries from snapshot (of ${snapshotSeedEntries.length} candidates)`,
                );
              } catch (seedError) {
                // Seeding is a pure optimisation — swallow failures so we
                // don't block the clone. The worst case is the first sync
                // does what it used to: pull everything via HTTP.
                void window.service.native.log(
                  'warn',
                  `TiddlyWeb clone: seedSyncState failed — ${(seedError as Error).message}`,
                );
              }
            }
          },
        },
      );

      // ── Stage 6: first sync (driven by main process; we just wait) ─────
      // `startIntervalSyncIfNeeded` inside wiki.startWiki() fires the first
      // sync automatically. We don't await it here because it can take minutes
      // for large wikis — instead the dialog subscribes to progress$ and
      // shows per-phase updates. The stage transitions to 'done' when the
      // observable emits `{ phase: 'finished' }` (handled by the dialog via
      // the setState callback it gets from the caller below).
      setState((previous) => ({ ...previous, stage: 'firstSync' }));
      wikiCreationMessageSetter('');
    } catch (error) {
      const message = (error as Error).message;
      wikiCreationMessageSetter(message);
      hasErrorSetter(true);
      setState((previous) => ({ ...previous, stage: 'error', error: message }));
      runningRef.current = false;
    }
  }, [form, tiddlywebForm, wikiCreationMessageSetter, hasErrorSetter, t]);

  // Watch progress$ for the 'finished' / 'error' phases so we can flip
  // stage → 'done' / 'error' without the caller having to wire up a second
  // subscription just for that. The dialog component also subscribes (to
  // show live per-phase detail), but its subscription is scoped to "render
  // only"; ours is "advance the overall state machine".
  useEffect(() => {
    if (state.stage !== 'firstSync' || state.workspaceId === undefined) return;
    const subscription = window.observables.tiddlyWebSync.progress$(state.workspaceId).subscribe({
      next: (event) => {
        if (event.phase === 'finished') {
          setState((previous) => ({ ...previous, stage: 'done' }));
          runningRef.current = false;
        } else if (event.phase === 'error') {
          setState((previous) => ({ ...previous, stage: 'error', error: event.message }));
          hasErrorSetter(true);
          runningRef.current = false;
        }
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [state.stage, state.workspaceId, hasErrorSetter]);

  return { state, start, reset };
}
