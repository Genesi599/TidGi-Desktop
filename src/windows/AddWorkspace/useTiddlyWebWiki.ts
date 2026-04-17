/**
 * Hooks for the "Clone from TiddlyWiki NodeJS Server" tab.
 *
 * Flow on submit:
 *   1. copyWikiTemplate(...)  — create an empty local TiddlyWiki folder
 *   2. Persist password to the OS keychain under `tiddlyweb-token`
 *   3. Build workspace config with storageService = 'tiddlyweb' and all
 *      tiddlyweb* fields populated from the TiddlyWeb form values
 *   4. callWikiInitialization(...) — register workspace, start wiki worker
 *   5. Fire the first sync pass (in the background — we don't block
 *      window-close on it; subsequent interval syncs catch up if needed).
 */
import { WikiCreationMethod } from '@/constants/wikiCreation';
import { SupportedStorageServices } from '@services/types';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callWikiInitialization } from './useCallWikiInitialization';
import type { ITiddlyWebWikiFormValues } from './TiddlyWebWikiForm';
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

export function useTiddlyWebWiki(
  form: IWikiWorkspaceForm,
  tiddlywebForm: ITiddlyWebWikiFormValues,
  wikiCreationMessageSetter: (m: string) => void,
  hasErrorSetter: (m: boolean) => void,
): () => Promise<void> {
  const { t } = useTranslation();

  return useCallback(async () => {
    wikiCreationMessageSetter(t('AddWorkspace.Processing'));
    hasErrorSetter(false);
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
      };

      // Password lives in the OS keychain, not the synced workspace config.
      await window.service.auth.set('tiddlyweb-token', tiddlywebForm.password);

      // Create a local wiki that the sync service will then hydrate.
      wikiCreationMessageSetter(t('AddWorkspace.TiddlyWebCloneCreatingLocalWiki'));
      await window.service.wiki.copyWikiTemplate(form.parentFolderLocation, form.wikiFolderName);
      // The template ships ~76 .tid/.json files (an Index.tid welcome tiddler
      // plus 12MB of plugin JSON bodies under tiddlers/system/). Without
      // clearing these, the first sync would treat them as new local content
      // and PUSH them to the remote server, polluting it. tiddlywiki.info,
      // plugins/, public/, scripts/ are untouched — they drive the local wiki
      // boot and never travel over the TiddlyWeb API.
      await window.service.wiki.emptyWikiTiddlersFolder(form.wikiFolderLocation);

      // Register + start the workspace. The wiki service's startWiki() then
      // calls sync's startIntervalSyncIfNeeded(), which for tiddlyweb fires an
      // immediate first sync (server-wins-with-local-backup on first run) and
      // then schedules the interval. So we don't need to call syncWorkspace
      // ourselves here — that would race with the wiki worker finishing boot.
      wikiCreationMessageSetter(t('AddWorkspace.TiddlyWebCloneInitializing'));
      await callWikiInitialization(
        newWorkspaceConfig,
        wikiCreationMessageSetter,
        t,
        undefined,
        { from: WikiCreationMethod.Create },
      );
    } catch (error) {
      wikiCreationMessageSetter((error as Error).message);
      hasErrorSetter(true);
    }
  }, [form, tiddlywebForm, wikiCreationMessageSetter, hasErrorSetter, t]);
}
