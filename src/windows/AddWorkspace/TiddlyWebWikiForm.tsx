/**
 * Form for the "Clone from TiddlyWiki NodeJS Server" tab.
 *
 * Collects:
 *   - Parent folder location (where to create the local wiki folder)
 *   - Wiki folder name
 *   - TiddlyWeb server URL, recipe, username, password
 *
 * Password is stored in React state only (not in the workspace form) and
 * persisted to the OS keychain under `tiddlyweb-token` at submit time.
 */
import FolderIcon from '@mui/icons-material/Folder';
import { Alert, Button, CircularProgress, Stack, Typography } from '@mui/material';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  CreateContainer,
  LocationPickerButton,
  LocationPickerContainer,
  LocationPickerInput,
} from './FormComponents';
import type { IWikiWorkspaceFormProps } from './useForm';

export interface ITiddlyWebWikiFormValues {
  url: string;
  recipe: string;
  username: string;
  password: string;
}

interface ITiddlyWebWikiFormProps extends IWikiWorkspaceFormProps {
  tiddlywebForm: ITiddlyWebWikiFormValues;
  tiddlywebFormSetter: React.Dispatch<React.SetStateAction<ITiddlyWebWikiFormValues>>;
}

export function TiddlyWebWikiForm({
  form,
  errorInWhichComponent,
  tiddlywebForm,
  tiddlywebFormSetter,
}: ITiddlyWebWikiFormProps): React.JSX.Element {
  const { t } = useTranslation();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | undefined>();

  const updateField = <K extends keyof ITiddlyWebWikiFormValues>(key: K, value: ITiddlyWebWikiFormValues[K]) => {
    tiddlywebFormSetter((previous) => ({ ...previous, [key]: value }));
  };

  const handleTest = async () => {
    if (!tiddlywebForm.url) return;
    setTesting(true);
    setTestResult(undefined);
    // Save credentials to keychain first so the service can read them.
    await window.service.auth.set('tiddlyweb-token', tiddlywebForm.password);
    // testConnection works on a live workspace id, but we can call a lightweight HEAD here too.
    // For the pre-creation case, construct the request manually.
    try {
      const baseUrl = tiddlywebForm.url.replace(/\/$/, '');
      const statusUrl = `${baseUrl}/status`;
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (tiddlywebForm.username.length > 0) {
        headers.Authorization = 'Basic ' + btoa(`${tiddlywebForm.username}:${tiddlywebForm.password}`);
      }
      const response = await fetch(statusUrl, { headers });
      if (response.ok) {
        const body = (await response.json()) as { tiddlywiki_version?: string; username?: string };
        setTestResult({
          ok: true,
          message: t('AddWorkspace.TiddlyWebCloneTestOK', {
            version: body.tiddlywiki_version ?? '?',
            username: body.username ?? '-',
          }),
        });
      } else {
        setTestResult({
          ok: false,
          message: t('AddWorkspace.TiddlyWebCloneTestFailed', {
            error: `HTTP ${response.status} ${response.statusText}`,
          }),
        });
      }
    } catch (error) {
      setTestResult({
        ok: false,
        message: t('AddWorkspace.TiddlyWebCloneTestFailed', { error: (error as Error).message }),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <CreateContainer elevation={2} square>
      <LocationPickerContainer>
        <LocationPickerInput
          error={errorInWhichComponent.parentFolderLocation}
          onChange={(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            form.parentFolderLocationSetter(event.target.value);
          }}
          label={t('AddWorkspace.WorkspaceParentFolder')}
          value={form.parentFolderLocation}
        />
        <LocationPickerButton
          onClick={async () => {
            form.parentFolderLocationSetter('');
            const filePaths = await window.service.native.pickDirectory(form.parentFolderLocation);
            if (filePaths.length > 0) {
              form.parentFolderLocationSetter(filePaths[0]);
            }
          }}
          endIcon={<FolderIcon />}
        >
          <Typography variant='button' display='inline'>
            {t('AddWorkspace.Choose')}
          </Typography>
        </LocationPickerButton>
      </LocationPickerContainer>
      <LocationPickerContainer>
        <LocationPickerInput
          error={errorInWhichComponent.wikiFolderName}
          onChange={(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            form.wikiFolderNameSetter(event.target.value);
          }}
          label={t('AddWorkspace.WorkspaceFolderNameToCreate')}
          helperText={`${t('AddWorkspace.CloneWiki')}${form.wikiFolderLocation ?? ''}`}
          value={form.wikiFolderName}
        />
      </LocationPickerContainer>

      <Stack spacing={2} sx={{ px: 2, pb: 2 }}>
        <LocationPickerInput
          label={t('AddWorkspace.TiddlyWebCloneUrl')}
          helperText={t('AddWorkspace.TiddlyWebCloneUrlDescription')}
          placeholder='https://wiki.example.com:8080'
          value={tiddlywebForm.url}
          onChange={(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            updateField('url', event.target.value);
          }}
        />
        <LocationPickerInput
          label={t('AddWorkspace.TiddlyWebCloneRecipe')}
          helperText={t('AddWorkspace.TiddlyWebCloneRecipeDescription')}
          placeholder='default'
          value={tiddlywebForm.recipe}
          onChange={(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            updateField('recipe', event.target.value);
          }}
        />
        <LocationPickerInput
          label={t('AddWorkspace.TiddlyWebCloneUsername')}
          helperText={t('AddWorkspace.TiddlyWebCloneUsernameDescription')}
          value={tiddlywebForm.username}
          onChange={(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            updateField('username', event.target.value);
          }}
        />
        <LocationPickerInput
          type='password'
          label={t('AddWorkspace.TiddlyWebClonePassword')}
          helperText={t('AddWorkspace.TiddlyWebClonePasswordDescription')}
          value={tiddlywebForm.password}
          onChange={(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            updateField('password', event.target.value);
          }}
        />
        <Button
          variant='outlined'
          size='small'
          disabled={testing || tiddlywebForm.url.length === 0}
          onClick={() => {
            void handleTest();
          }}
          startIcon={testing ? <CircularProgress size={14} /> : undefined}
          sx={{ alignSelf: 'flex-start' }}
          data-testid='tiddlyweb-clone-test-button'
        >
          {t('AddWorkspace.TiddlyWebCloneTestConnection')}
        </Button>
        {testResult && (
          <Alert severity={testResult.ok ? 'success' : 'error'}>
            {testResult.message}
          </Alert>
        )}
      </Stack>
    </CreateContainer>
  );
}
