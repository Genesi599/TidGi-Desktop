/**
 * TiddlyWeb sync configuration panel.
 *
 * Rendered as a custom item inside the "Save and Sync" section. Only visible
 * when `workspace.storageService === 'tiddlyweb'`. Combines:
 *   - Config inputs (URL / recipe / username / password / interval / exclude filter)
 *   - Action buttons (Test connection / Sync now / Reset state)
 *   - Live progress (subscribes to tiddlyWebSync.progress$ observable)
 *   - Status panel (last sync time, tracked tiddler count, last error)
 *
 * Password is stored in the OS keychain under the `tiddlyweb-token` key via
 * the auth service — NOT in the workspace config (which syncs across devices).
 */
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  LinearProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ListItemText } from '@/components/ListItem';
import type {
  TiddlyWebSyncProgressEvent,
  TiddlyWebSyncStatus,
} from '@services/tiddlywebSync/interface';
import { SupportedStorageServices } from '@services/types';
import { isWikiWorkspace, wikiWorkspaceDefaultValues } from '@services/workspaces/interface';
import { ListItemVertical } from '../../Preferences/PreferenceComponents';
import { useWorkspaceForm } from '../WorkspaceFormContext';

/** Phases during which we render the indeterminate/linear progress bar. */
const IN_FLIGHT_PHASES: ReadonlySet<TiddlyWebSyncProgressEvent['phase']> = new Set([
  'started',
  'listing-remote',
  'reading-local',
  'reconciled',
  'applying',
]);

export function TiddlyWebConfigItem(): React.JSX.Element | null {
  const { t } = useTranslation();
  const { workspace, workspaceSetter } = useWorkspaceForm();

  const storageService = isWikiWorkspace(workspace)
    ? workspace.storageService ?? wikiWorkspaceDefaultValues.storageService
    : undefined;
  const isTiddlyWeb = storageService === SupportedStorageServices.tiddlyweb;

  // --- Password (keychain-backed, separate from workspace config) ----------
  const [password, setPassword] = useState<string>('');
  const [passwordLoaded, setPasswordLoaded] = useState(false);
  useEffect(() => {
    if (!isTiddlyWeb) return;
    void window.service.auth.get('tiddlyweb-token').then((value) => {
      setPassword(value ?? '');
      setPasswordLoaded(true);
    });
  }, [isTiddlyWeb]);

  // --- Live progress (observable) -----------------------------------------
  const workspaceId = isWikiWorkspace(workspace) ? workspace.id : '';
  const [progress, setProgress] = useState<TiddlyWebSyncProgressEvent | undefined>();
  useEffect(() => {
    if (!isTiddlyWeb || !workspaceId) return;
    const subscription = window.observables.tiddlyWebSync.progress$(workspaceId).subscribe({
      next: (event: TiddlyWebSyncProgressEvent) => {
        setProgress(event);
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [isTiddlyWeb, workspaceId]);

  // --- Status (polled on demand) ------------------------------------------
  const [status, setStatus] = useState<TiddlyWebSyncStatus | undefined>();
  const refreshStatus = useCallback(() => {
    if (!isTiddlyWeb || !workspaceId) return;
    void window.service.tiddlyWebSync.getStatus(workspaceId).then(setStatus);
  }, [isTiddlyWeb, workspaceId]);
  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);
  // Refresh status when a sync finishes
  useEffect(() => {
    if (progress?.phase === 'finished' || progress?.phase === 'error') {
      refreshStatus();
    }
  }, [progress?.phase, refreshStatus]);

  // --- UI state -----------------------------------------------------------
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | undefined>();
  const [syncing, setSyncing] = useState(false);

  // Early return AFTER hooks (rules of hooks — no conditional hooks before here)
  if (!isWikiWorkspace(workspace) || !isTiddlyWeb) return null;

  const defaults = wikiWorkspaceDefaultValues;
  const url = workspace.tiddlywebUrl ?? defaults.tiddlywebUrl ?? '';
  const recipe = workspace.tiddlywebRecipe ?? defaults.tiddlywebRecipe;
  const username = workspace.tiddlywebUsername ?? defaults.tiddlywebUsername;
  const intervalMs = workspace.tiddlywebSyncIntervalMs ?? defaults.tiddlywebSyncIntervalMs;
  const excludeFilter = workspace.tiddlywebExcludeFilter ?? defaults.tiddlywebExcludeFilter;

  const inFlight = (progress !== undefined && IN_FLIGHT_PHASES.has(progress.phase)) || syncing
    || (status?.inFlight ?? false);
  const isBusy = inFlight || testing;
  const hasUrl = url.trim().length > 0;

  // --- Handlers -----------------------------------------------------------
  const persistPassword = (value: string) => {
    setPassword(value);
    void window.service.auth.set('tiddlyweb-token', value);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(undefined);
    try {
      const result = await window.service.tiddlyWebSync.testConnection(workspace.id);
      if (result.reachable) {
        setTestResult({
          ok: true,
          message: t('EditWorkspace.TiddlyWebTestConnectionOK', {
            version: result.serverInfo?.tiddlywikiVersion ?? '?',
            username: result.serverInfo?.username ?? '-',
          }),
        });
      } else {
        setTestResult({
          ok: false,
          message: t('EditWorkspace.TiddlyWebTestConnectionFailed', { error: result.error ?? '' }),
        });
      }
    } catch (error) {
      setTestResult({ ok: false, message: (error as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      await window.service.tiddlyWebSync.syncWorkspace(workspace.id);
    } catch (error) {
      void window.service.native.log('error', `TiddlyWeb sync failed: ${(error as Error).message}`);
    } finally {
      setSyncing(false);
      refreshStatus();
    }
  };

  const handleReset = async () => {
    if (!window.confirm(t('EditWorkspace.TiddlyWebResetConfirm'))) return;
    await window.service.tiddlyWebSync.resetSyncState(workspace.id);
    refreshStatus();
  };

  // --- Render -------------------------------------------------------------
  return (
    <ListItemVertical>
      <ListItemText
        primary={t('EditWorkspace.TiddlyWebConfig')}
        secondary={t('EditWorkspace.TiddlyWebConfigDescription')}
      />

      <Stack spacing={2} sx={{ width: '100%' }}>
        <TextField
          size='small'
          fullWidth
          variant='standard'
          label={t('EditWorkspace.TiddlyWebUrl')}
          helperText={t('EditWorkspace.TiddlyWebUrlDescription')}
          placeholder='https://wiki.example.com:8080'
          value={url}
          onChange={(event) => {
            const next = event.target.value;
            workspaceSetter({ ...workspace, tiddlywebUrl: next.length === 0 ? null : next });
          }}
          data-testid='tiddlyweb-url-input'
        />
        <TextField
          size='small'
          fullWidth
          variant='standard'
          label={t('EditWorkspace.TiddlyWebRecipe')}
          helperText={t('EditWorkspace.TiddlyWebRecipeDescription')}
          placeholder='default'
          value={recipe}
          onChange={(event) => {
            workspaceSetter({ ...workspace, tiddlywebRecipe: event.target.value });
          }}
          data-testid='tiddlyweb-recipe-input'
        />
        <TextField
          size='small'
          fullWidth
          variant='standard'
          label={t('EditWorkspace.TiddlyWebUsername')}
          helperText={t('EditWorkspace.TiddlyWebUsernameDescription')}
          value={username}
          onChange={(event) => {
            workspaceSetter({ ...workspace, tiddlywebUsername: event.target.value });
          }}
          data-testid='tiddlyweb-username-input'
        />
        <TextField
          size='small'
          fullWidth
          variant='standard'
          type='password'
          autoComplete='new-password'
          label={t('EditWorkspace.TiddlyWebPassword')}
          helperText={t('EditWorkspace.TiddlyWebPasswordDescription')}
          value={password}
          disabled={!passwordLoaded}
          onChange={(event) => {
            persistPassword(event.target.value);
          }}
          data-testid='tiddlyweb-password-input'
        />
        <TextField
          size='small'
          fullWidth
          variant='standard'
          type='number'
          label={t('EditWorkspace.TiddlyWebSyncIntervalMs')}
          helperText={t('EditWorkspace.TiddlyWebSyncIntervalMsDescription')}
          value={intervalMs}
          slotProps={{ htmlInput: { min: 1000, step: 1000 } }}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (!Number.isNaN(next) && next >= 1000) {
              workspaceSetter({ ...workspace, tiddlywebSyncIntervalMs: next });
            }
          }}
          data-testid='tiddlyweb-interval-input'
        />
        <TextField
          size='small'
          fullWidth
          variant='standard'
          label={t('EditWorkspace.TiddlyWebExcludeFilter')}
          helperText={t('EditWorkspace.TiddlyWebExcludeFilterDescription')}
          value={excludeFilter}
          onChange={(event) => {
            workspaceSetter({ ...workspace, tiddlywebExcludeFilter: event.target.value });
          }}
          data-testid='tiddlyweb-exclude-filter-input'
        />
      </Stack>

      <Stack direction='row' spacing={1} sx={{ mt: 2, flexWrap: 'wrap' }}>
        <Button
          variant='outlined'
          size='small'
          disabled={isBusy || !hasUrl}
          onClick={() => {
            void handleTest();
          }}
          startIcon={testing ? <CircularProgress size={14} /> : undefined}
          data-testid='tiddlyweb-test-button'
        >
          {t('EditWorkspace.TiddlyWebTestConnection')}
        </Button>
        <Button
          variant='contained'
          size='small'
          disableElevation
          disabled={isBusy || !hasUrl}
          onClick={() => {
            void handleSync();
          }}
          data-testid='tiddlyweb-sync-now-button'
        >
          {inFlight ? t('EditWorkspace.TiddlyWebSyncing') : t('EditWorkspace.TiddlyWebSyncNow')}
        </Button>
        <Button
          variant='outlined'
          size='small'
          color='warning'
          disabled={isBusy}
          onClick={() => {
            void handleReset();
          }}
          data-testid='tiddlyweb-reset-button'
        >
          {t('EditWorkspace.TiddlyWebResetState')}
        </Button>
      </Stack>

      {testResult && (
        <Alert severity={testResult.ok ? 'success' : 'error'} sx={{ mt: 2, width: '100%' }}>
          {testResult.message}
        </Alert>
      )}

      {progress && IN_FLIGHT_PHASES.has(progress.phase) && (
        <Box sx={{ mt: 2, width: '100%' }}>
          <Typography variant='caption' display='block' sx={{ mb: 0.5 }}>
            {describeProgress(progress, t)}
          </Typography>
          {progress.phase === 'applying' && progress.total > 0
            ? (
              <LinearProgress
                variant='determinate'
                value={(progress.completed / progress.total) * 100}
              />
            )
            : <LinearProgress variant='indeterminate' />}
        </Box>
      )}

      {progress?.phase === 'error' && (
        <Alert severity='error' sx={{ mt: 2, width: '100%' }}>{progress.message}</Alert>
      )}

      {status && (
        <Box sx={{ mt: 2, width: '100%' }}>
          <Typography variant='caption' display='block' color='text.secondary'>
            {t('EditWorkspace.TiddlyWebLastSync')}: {formatLastSync(status.lastFullSyncAt, t)}
          </Typography>
          <Typography variant='caption' display='block' color='text.secondary'>
            {t('EditWorkspace.TiddlyWebTrackedCount', { count: status.trackedTiddlerCount })}
          </Typography>
          {status.lastError && (
            <Alert severity='warning' sx={{ mt: 1 }}>{status.lastError}</Alert>
          )}
        </Box>
      )}
    </ListItemVertical>
  );
}

function describeProgress(
  event: TiddlyWebSyncProgressEvent,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (event.phase) {
    case 'started':
      return t('EditWorkspace.TiddlyWebProgressStarted');
    case 'listing-remote':
      return t('EditWorkspace.TiddlyWebProgressListing');
    case 'reading-local':
      return t('EditWorkspace.TiddlyWebProgressReading');
    case 'reconciled':
      return t('EditWorkspace.TiddlyWebProgressReconciled', { count: event.summary.total });
    case 'applying':
      return t('EditWorkspace.TiddlyWebProgressApplying', {
        completed: event.completed,
        total: event.total,
        title: event.currentTitle ?? '',
      });
    default:
      return '';
  }
}

function formatLastSync(
  timestamp: number | undefined,
  t: (key: string) => string,
): string {
  if (timestamp === undefined || timestamp === 0) return t('EditWorkspace.TiddlyWebNeverSynced');
  return new Date(timestamp).toLocaleString();
}
