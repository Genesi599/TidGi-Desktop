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

Object.assign(window as unknown as Record<string, unknown>, {
  service: {
    auth: { set: authSet },
    native: { pickDirectory },
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
    // Reset fetch mock for each test
    // Some suites may not have fetch in jsdom; stub it.
    (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn();
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

  it('Test Connection strips trailing slash, adds Basic auth, and persists password to keychain', async () => {
    const user = userEvent.setup();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tiddlywiki_version: '5.3.3', username: 'me' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    (globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

    render(
      <Harness
        form={makeForm()}
        initial={{ url: 'http://wiki.example.com:8080/', recipe: 'default', username: 'me', password: 'sekret' }}
      />,
    );

    await user.click(screen.getByTestId('tiddlyweb-clone-test-button'));

    // Assert the fetch happened with the right shape.
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const [calledUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    // Trailing slash on baseUrl must be stripped
    expect(calledUrl).toBe('http://wiki.example.com:8080/status');
    // Basic auth: base64("me:sekret") == "bWU6c2VrcmV0"
    expect((init.headers as Record<string, string>).Authorization).toBe('Basic bWU6c2VrcmV0');
    expect((init.headers as Record<string, string>).Accept).toBe('application/json');

    // Password is persisted to keychain before the HTTP call
    expect(authSet).toHaveBeenCalledWith('tiddlyweb-token', 'sekret');

    // Success alert appears (looks for the i18n key with interpolated args)
    await waitFor(() => {
      expect(screen.getByText(/AddWorkspace\.TiddlyWebCloneTestOK/)).toBeInTheDocument();
    });
  });

  it('Test Connection omits Authorization header when username is empty', async () => {
    const user = userEvent.setup();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tiddlywiki_version: '5.3.3' }), { status: 200 }),
    );
    (globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

    render(
      <Harness form={makeForm()} initial={{ url: 'http://w', recipe: 'default', username: '', password: '' }} />,
    );
    await user.click(screen.getByTestId('tiddlyweb-clone-test-button'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('Test Connection shows failure alert on non-2xx', async () => {
    const user = userEvent.setup();
    const mockFetch = vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

    render(<Harness form={makeForm()} initial={{ url: 'http://w', recipe: 'default', username: 'x', password: 'bad' }} />);
    await user.click(screen.getByTestId('tiddlyweb-clone-test-button'));

    await waitFor(() => {
      // Failure message contains the interpolated error string
      expect(screen.getByText(/AddWorkspace\.TiddlyWebCloneTestFailed/)).toBeInTheDocument();
    });
  });

  it('Test Connection shows failure alert on network error', async () => {
    const user = userEvent.setup();
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

    render(<Harness form={makeForm()} initial={{ url: 'http://w', recipe: 'default', username: '', password: '' }} />);
    await user.click(screen.getByTestId('tiddlyweb-clone-test-button'));

    await waitFor(() => {
      expect(screen.getByText(/AddWorkspace\.TiddlyWebCloneTestFailed.*ECONNREFUSED/)).toBeInTheDocument();
    });
  });
});
