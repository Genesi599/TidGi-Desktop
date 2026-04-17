import { WikiCreationMethod } from '@/constants/wikiCreation';
import type { IGitUserInfos } from '@services/git/interface';
import type { INewWikiWorkspaceConfig, IWorkspace } from '@services/workspaces/interface';
import type { TFunction } from 'i18next';

interface ICallWikiInitConfig {
  from: WikiCreationMethod;
  notClose?: boolean;
  /**
   * Called between the "register workspace" and "initialize view" steps so
   * UI can surface substage transitions. `workspace` is populated once
   * `initWikiGitTransaction` resolves; view init hasn't started yet.
   *
   * May be async — we await it so the caller can do setup work (e.g. seeding
   * TiddlyWebSync state from an HTML snapshot) that must complete before the
   * wiki worker boots and the first auto-sync fires during view init. If the
   * callback throws, the init pipeline aborts before view init.
   */
  onWorkspaceRegistered?: (workspace: IWorkspace) => void | Promise<void>;
}

/**
 * @returns the newly created workspace. Callers that want to subscribe to
 *   per-workspace progress (e.g. the TiddlyWeb clone dialog watching the
 *   first sync) need the id before the window closes, so return it even
 *   though most call sites ignore it.
 */
export async function callWikiInitialization(
  newWorkspaceConfig: INewWikiWorkspaceConfig,
  wikiCreationMessageSetter: (m: string) => void,
  t: TFunction,
  gitUserInfo: IGitUserInfos | undefined,
  configs: ICallWikiInitConfig,
): Promise<IWorkspace> {
  wikiCreationMessageSetter(t('Log.InitializeWikiGit'));
  const newWorkspace = await window.service.wikiGitWorkspace.initWikiGitTransaction(newWorkspaceConfig, gitUserInfo);
  if (newWorkspace === undefined) {
    throw new Error('newWorkspace is undefined');
  }
  await configs.onWorkspaceRegistered?.(newWorkspace);
  // start wiki on startup, or on sub-wiki creation
  wikiCreationMessageSetter(t('Log.InitializeWorkspaceView'));
  /** create workspace from workspaceService to store workspace configs, and create a WebContentsView to actually display wiki web content from viewService */
  await window.service.workspaceView.initializeWorkspaceView(newWorkspace, { isNew: true, from: configs.from });
  wikiCreationMessageSetter(t('Log.InitializeWorkspaceViewDone'));
  await window.service.workspaceView.setActiveWorkspaceView(newWorkspace.id);
  wikiCreationMessageSetter('');
  if (configs.notClose !== true) {
    // wait for wiki to start and close the window now.
    await window.remote.closeCurrentWindow();
  }
  return newWorkspace;
}
