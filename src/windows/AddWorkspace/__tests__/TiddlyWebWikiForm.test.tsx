import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IGitUserInfos } from '@services/git/interface';
import { SupportedStorageServices } from '@services/types';
import { IWorkspace } from '@services/workspaces/interface';
import { type ITiddlyWebWikiFormValues, TiddlyWebWikiForm } from '../TiddlyWebWikiForm';
import type { IErrorInWhichComponent, IWikiWorkspaceForm } from '../useForm';

// ── i18next ────────────────────────────────────────────────────────────────
// Real react-i18next expects an i18n instance. For these pure-rendering tests
// we stub useTranslation to echo the key, which is enough to assert structure.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}|${JSON.stringify(options)}` : key,
  }),
}));

// ── window.service stubs ───────────────────────────────────────────────────
// IMPORTANT: do NOT overwrite globalThis.window — jsdom attaches document to
// the existing Window object. We augment it instead.
const authSet = vi.fn<(key: string, value: string) => Promise<void>>().mockResolvedValue(undefined);
const pickDirectory = vi.fn<(start?: string) => Promise<string[]>>().mockResolvedValue([]);
// testServerAdHoc lives on window.service.tiddlyWebSync — the form delegates
// its "Test Connection" button to the main-process service (bypassing
// renderer CORS, which breaks direct fetch against most TW servers).
const testServerAdHoc = vi.fn<(
  url: string,
  recipe: string,
  username: string,
  password: string,
) => Promise<{ reachable: boolean; serverInfo?: { tiddlywikiVersion?: string; username?: string }; error?: string }>>()
  .mockResolvedValue({ reachable: true, serverInfo: { tiddlywikiVersion: '5.3.3', username: 'me' } });

Object.assign(window as unknown as Record<string, unknown>, {
  service: {
    auth: { set: authSet },
    native: { pickDirectory },
    tiddlyWebSync: { testServerAdHoc },
  },
});

// ── Mock IWikiWorkspaceForm ────────────────────────────────────────────────
const makeForm = (overrides: Partial<IWikiWorkspaceForm> = {}): IWikiWorkspaceForm => ({
  storageProvider: SupportedStorageServices.tiddlyweb,
  storageProviderSetter: vi.fn(),
  wikiPort: 5212,
  wikiPortSetter: vi.fn(),
  parentFolderLocation: '/tmp/p',
  parentFolderLocationSetter: vi.fn(),
  wikiFolderName: 'my-wiki',
  wikiFolderNameSetter: vi.fn(),
  wikiFolderLocation: '/tmp/p/my-wiki',
  mainWikiToLink: { wikiFolderLocation: '', id: '', port: 0 },
  mainWikiToLinkSetter: vi.fn(),
  mainWikiToLinkIndex: 0,
  mainWorkspaceList: [] as IWorkspace[],
  tagNames: [] as string[],
  tagNamesSetter: vi.fn(),
  gitRepoUrl: '',
  gitRepoUrlSetter: vi.fn(),
  gitUserInfo: undefined as IGitUserInfos | undefined,
  workspaceList: [] as IWorkspace[],
  wikiHtmlPath: '',
  wikiHtmlPathSetter: vi.fn(),
  ...overrides,
});

// Wrapper that provides the local tiddlyweb form state the component expects.
function Harness({
  form,
  initial,
  errorInWhichComponent = {},
  errorInWhichComponentSetter = vi.fn(),
}: {
  form: IWikiWorkspaceForm;
  initial: ITiddlyWebWikiFormValues;
  errorInWhichComponent?: IErrorInWhichComponent;
  errorInWhichComponentSetter?: (errors: IErrorInWhichComponent) => void;
}) {
  const [state, setState] = useState<ITiddlyWebWikiFormValues>(initial);
  return (
    <TiddlyWebWikiForm
      form={form}
      isCreateMainWorkspace
      errorInWhichComponent={errorInWhichComponent}
      errorInWhichComponentSetter={errorInWhichComponentSetter}
      tiddlywebForm={state}
      tiddlywebFormSetter={setState}
    />
  );
}

const EMPTY_TIDDLYWEB: ITiddlyWebWikiFormValues = { url: '', recipe: 'default', username: '', password: '' };

describe('TiddlyWebWikiForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authSet.mockResolvedValue(undefined);
    pickDirectory.mockResolvedValue([]);
    testServerAdHoc.mockResolvedValue({
      reachable: true,
      serverInfo: { tiddlywikiVersion: '5.3.3', username: 'me' },
    });
  });

  it('renders URL / recipe / username / password fields and the test button', () => {
    render(<Harness form={makeForm()} initial={EMPTY_TIDDLYWEB} />);
    // Labels are keys due to i18n stub. All four text fields show up.
    expect(screen.getByText('AddWorkspace.TiddlyWebCloneUrl')).toBeInTheDocument();
    expect(screen.getByText('AddWorkspace.TiddlyWebCloneRecipe')).toBeInTheDocument();
    expect(screen.getByText('AddWorkspace.TiddlyWebCloneUsername')).toBeInTheDocument();
    expect(screen.getByText('AddWorkspace.TiddlyWebClonePassword')).toBeInTheDocument();
    expect(screen.getByTestId('tiddlyweb-clone-test-button')).toBeInTheDocument();
  });

  it('test button is disabled until a URL is entered', async () => {
    const user = userEvent.setup();
    render(<Harness form={makeForm()} initial={EMPTY_TIDDLYWEB} />);
    expect(screen.getByTestId('tiddlyweb-clone-test-button')).toBeDisabled();

    const urlInputs = screen.getAllByRole('textbox');
    // URL is the first form field rendered after the parent-folder/wiki-folder-name inputs.
    // Safer: find by placeholder.
    const urlInput = screen.getByPlaceholderText('https://wiki.example.com:8080');
    await user.type(urlInput, 'http://localhost:8080');

    await waitFor(() => {
      expect(screen.getByTestId('tiddlyweb-clone-test-button')).not.toBeDisabled();
    });
    expect(urlInputs.length).toBeGreaterThan(0);
  });

  it('Test Connection delegates to main-process service (bypasses renderer CORS) and saves password to keychain', async () => {
    const user = userEvent.setup();

    render(
      <Harness
        form={makeForm()}
        initial={{ url: 'http://wiki.example.com:8080/', recipe: 'default', username: 'me', password: 'sekret' }}
      />,
    );

    await user.click(screen.getByTestId('tiddlyweb-clone-test-button'));

    // Password is persisted to keychain before the call (so the main-process
    // service + later the sync worker all read the same value).
    await waitFor(() => {
      expect(authSet).toHaveBeenCalledWith('tiddlyweb-token', 'sekret');
    });
    // Service is called with the raw form values; trailing-slash / auth
    // normalisation happens in the main process, not the form.
    expect(testServerAdHoc).toHaveBeenCalledTimes(1);
    expect(testServerAdHoc).toHaveBeenCalledWith(
      'http://wiki.example.com:8080/',
      'default',
      'me',
      'sekret',
    );
    await waitFor(() => {
      expect(screen.getByText(/AddWorkspace\.TiddlyWebCloneTestOK/)).toBeInTheDocument();
    });
  });

  it('Test Connection passes empty username/password through (no client-side branching)', async () => {
    const user = userEvent.setup();
    render(
      <Harness form={makeForm()} initial={{ url: 'http://w', recipe: 'default', username: '', password: '' }} />,
    );
    await user.click(screen.getByTestId('tiddlyweb-clone-test-button'));

    await waitFor(() => expect(testServerAdHoc).toHaveBeenCalledTimes(1));
    expect(testServerAdHoc).toHaveBeenCalledWith('http://w', 'default', '', '');
  });

  it('Test Connection shows failure alert when service reports unreachable', async () => {
    const user = userEvent.setup();
    testServerAdHoc.mockResolvedValueOnce({ reachable: false, error: 'HTTP 401 Unauthorized' });

    render(<Harness form={makeForm()} initial={{ url: 'http://w', recipe: 'default', username: 'x', password: 'bad' }} />);
    await user.click(screen.getByTestId('tiddlyweb-clone-test-button'));

    await waitFor(() => {
      expect(screen.getByText(/AddWorkspace\.TiddlyWebCloneTestFailed/)).toBeInTheDocument();
    });
  });

  it('Test Connection shows failure alert on service exception', async () => {
    const user = userEvent.setup();
    testServerAdHoc.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    render(<Harness form={makeForm()} initial={{ url: 'http://w', recipe: 'default', username: '', password: '' }} />);
    await user.click(screen.getByTestId('tiddlyweb-clone-test-button'));

    await waitFor(() => {
      expect(screen.getByText(/AddWorkspace\.TiddlyWebCloneTestFailed.*ECONNREFUSED/)).toBeInTheDocument();
    });
  });
});
