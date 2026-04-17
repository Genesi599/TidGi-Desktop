import { Button, MenuItem, Tooltip } from '@mui/material';
import React from 'react';
import { useTranslation } from 'react-i18next';

import { ListItem, ListItemText } from '@/components/ListItem';
import { TokenForm } from '@/components/TokenForm';
import { SupportedStorageServices } from '@services/types';
import { isWikiWorkspace, wikiWorkspaceDefaultValues } from '@services/workspaces/interface';
import { SyncedWikiDescription } from '../../AddWorkspace/Description';
import { GitRepoUrlForm } from '../../AddWorkspace/GitRepoUrlForm';
import { ListItemVertical, TextField } from '../../Preferences/PreferenceComponents';
import { useWorkspaceForm } from '../WorkspaceFormContext';

/** Providers offered when the workspace is in "synced" mode. */
const SYNCED_PROVIDER_OPTIONS: ReadonlyArray<{ value: SupportedStorageServices; label: string }> = [
  { value: SupportedStorageServices.github, label: 'GitHub' },
  { value: SupportedStorageServices.gitlab, label: 'GitLab' },
  { value: SupportedStorageServices.codeberg, label: 'Codeberg' },
  { value: SupportedStorageServices.gitea, label: 'Gitea' },
  { value: SupportedStorageServices.tiddlyweb, label: 'TiddlyWiki NodeJS Server' },
  { value: SupportedStorageServices.testOAuth, label: 'Custom OAuth' },
];

export function WorkspacePathItem(): React.JSX.Element {
  const { t } = useTranslation();
  const { workspace } = useWorkspaceForm();
  const wikiFolderLocation = isWikiWorkspace(workspace) ? workspace.wikiFolderLocation : '';
  return (
    <ListItemVertical>
      <ListItemText primary={t('EditWorkspace.Path')} secondary={t('EditWorkspace.PathDescription')} />
      <TextField
        fullWidth
        placeholder='Optional'
        disabled
        value={wikiFolderLocation}
      />
      <Tooltip title={t('EditWorkspace.MoveWorkspaceTooltip') ?? ''} placement='top'>
        <Button
          variant='outlined'
          size='small'
          sx={{ mt: 1 }}
          onClick={async () => {
            const directories = await window.service.native.pickDirectory();
            if (directories.length > 0) {
              const newLocation = directories[0];
              try {
                await window.service.wikiGitWorkspace.moveWorkspaceLocation(workspace.id, newLocation);
              } catch (error) {
                const errorMessage = (error as Error).message;
                void window.service.native.log('error', `Failed to move workspace: ${errorMessage}`, { error, workspaceID: workspace.id, newLocation });
                void window.service.notification.show({
                  title: t('EditWorkspace.MoveWorkspaceFailed'),
                  body: t('EditWorkspace.MoveWorkspaceFailedMessage', { name: workspace.name, error: errorMessage }),
                });
              }
            }
          }}
        >
          {t('EditWorkspace.MoveWorkspace')}
        </Button>
      </Tooltip>
    </ListItemVertical>
  );
}

export function StorageServiceSwitchItem(): React.JSX.Element | null {
  const { workspace, workspaceSetter } = useWorkspaceForm();
  if (!isWikiWorkspace(workspace)) return null;
  const storageService = workspace.storageService ?? wikiWorkspaceDefaultValues.storageService;
  const isCreateSyncedWorkspace = storageService !== SupportedStorageServices.local;
  return (
    <ListItem>
      <SyncedWikiDescription
        isCreateSyncedWorkspace={isCreateSyncedWorkspace}
        isCreateSyncedWorkspaceSetter={(isSynced: boolean) => {
          workspaceSetter({ ...workspace, storageService: isSynced ? SupportedStorageServices.github : SupportedStorageServices.local });
        }}
      />
    </ListItem>
  );
}

/** Dropdown to pick the sync backend. Only visible when not local. */
export function StorageProviderSelectItem(): React.JSX.Element | null {
  const { t } = useTranslation();
  const { workspace, workspaceSetter } = useWorkspaceForm();
  if (!isWikiWorkspace(workspace)) return null;
  const storageService = workspace.storageService ?? wikiWorkspaceDefaultValues.storageService;
  if (storageService === SupportedStorageServices.local) return null;
  return (
    <ListItem>
      <ListItemText
        primary={t('EditWorkspace.StorageProvider')}
        secondary={t('EditWorkspace.StorageProviderDescription')}
      />
      <TextField
        select
        size='small'
        value={storageService}
        onChange={(event) => {
          workspaceSetter({ ...workspace, storageService: event.target.value as SupportedStorageServices });
        }}
        sx={{ minWidth: 220 }}
        data-testid='storage-provider-select'
      >
        {SYNCED_PROVIDER_OPTIONS.map(({ value, label }) => (
          <MenuItem key={value} value={value}>{label}</MenuItem>
        ))}
      </TextField>
    </ListItem>
  );
}

export function TokenFormItem(): React.JSX.Element | null {
  const { workspace, workspaceSetter } = useWorkspaceForm();
  if (!isWikiWorkspace(workspace)) return null;
  const storageService = workspace.storageService ?? wikiWorkspaceDefaultValues.storageService;
  // TokenForm is git-provider specific (github/gitlab/gitea/codeberg/testOAuth).
  // Hide for local and for tiddlyweb (which uses its own keychain entry).
  if (storageService === SupportedStorageServices.local || storageService === SupportedStorageServices.tiddlyweb) return null;
  return (
    <ListItem>
      <TokenForm
        storageProvider={storageService}
        storageProviderSetter={(nextStorageService) => {
          workspaceSetter({ ...workspace, storageService: nextStorageService });
        }}
      />
    </ListItem>
  );
}

export function GitRepoUrlItem(): React.JSX.Element | null {
  const { workspace, workspaceSetter } = useWorkspaceForm();
  if (!isWikiWorkspace(workspace)) return null;
  const storageService = workspace.storageService ?? wikiWorkspaceDefaultValues.storageService;
  // Git repo URL is irrelevant for local and tiddlyweb workspaces.
  if (storageService === SupportedStorageServices.local || storageService === SupportedStorageServices.tiddlyweb) return null;
  return (
    <ListItem>
      <GitRepoUrlForm
        storageProvider={storageService}
        gitRepoUrl={workspace.gitUrl ?? ''}
        gitRepoUrlSetter={(nextGitUrl: string) => {
          workspaceSetter({ ...workspace, gitUrl: nextGitUrl });
        }}
        isCreateMainWorkspace={!workspace.isSubWiki}
      />
    </ListItem>
  );
}
