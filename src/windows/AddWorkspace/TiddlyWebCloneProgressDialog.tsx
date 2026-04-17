/**
 * Progress dialog shown during a "Clone from TiddlyWeb server" workflow.
 *
 * The clone has two distinct progress sources that this dialog stitches
 * together into one linear view:
 *
 *   (a) Renderer-driven stages — the caller walks through them sequentially
 *       and reports which one is currently running by passing `state` down.
 *       These are: creating the local wiki folder, clearing template tiddlers,
 *       downloading the HTML snapshot, registering the workspace, and
 *       starting the wiki worker.
 *
 *   (b) The first sync — once the workspace is registered the main-process
 *       `TiddlyWebSync` service fires a sync pass and emits events through
 *       `tiddlyWebSync.progress$(workspaceId)`. The dialog subscribes once
 *       `state.workspaceId` is set and renders those events as the final row.
 *
 * The dialog is modal and deliberately non-dismissible while anything is
 * running — the user would otherwise be tempted to close the AddWorkspace
 * window while the main process is still importing tens of thousands of
 * tiddlers, which looks broken. Close only becomes available at `done` or
 * `error`.
 */
import CancelIcon from '@mui/icons-material/Cancel';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { TiddlyWebSyncProgressEvent } from '@services/tiddlywebSync/interface';

/**
 * Renderer-side clone progress. Produced by `useTiddlyWebWiki` and fed into
 * this dialog. `workspaceId` is populated once `initWikiGitTransaction`
 * resolves — from that point on the dialog can subscribe to `progress$`.
 */
export type TiddlyWebCloneStage =
  | 'idle'
  | 'copyingTemplate'
  | 'clearingTiddlers'
  | 'downloadingSnapshot'
  | 'registeringWorkspace'
  | 'startingWiki'
  | 'firstSync'
  | 'done'
  | 'error';

export interface TiddlyWebCloneState {
  stage: TiddlyWebCloneStage;
  /** Available once the workspace has been registered. */
  workspaceId?: string;
  /** If the HTML snapshot import succeeded, how many tiddlers landed. */
  snapshotImported?: number;
  /** If the HTML snapshot was skipped, the reason (stringified exception). */
  snapshotSkipReason?: string;
  /** Populated when `stage === 'error'`. */
  error?: string;
}

interface TiddlyWebCloneProgressDialogProps {
  open: boolean;
  state: TiddlyWebCloneState;
  /** Called when the user dismisses the dialog. Only enabled at done/error. */
  onClose: () => void;
}

/**
 * Relative order of the renderer-driven stages — used to decide whether a
 * given row is "pending / active / done" given the current stage.
 */
const STAGE_ORDER: readonly TiddlyWebCloneStage[] = [
  'copyingTemplate',
  'clearingTiddlers',
  'downloadingSnapshot',
  'registeringWorkspace',
  'startingWiki',
  'firstSync',
  'done',
];

function stageRank(stage: TiddlyWebCloneStage): number {
  const index = STAGE_ORDER.indexOf(stage);
  return index === -1 ? -1 : index;
}

type RowStatus = 'pending' | 'active' | 'done' | 'error';

function rowStatus(
  rowStage: TiddlyWebCloneStage,
  currentStage: TiddlyWebCloneStage,
): RowStatus {
  if (currentStage === 'error') {
    // Everything that hasn't started yet is pending; everything that has is "done-ish".
    // We don't know precisely which row threw, so surface the failure only on the
    // row that matches the current stage when we transitioned to error. Callers
    // hold the last-active stage separately if they want that granularity; for
    // simplicity we mark the current row error and the rest pending/done by rank.
    return stageRank(rowStage) < stageRank(currentStage) ? 'done' : rowStage === currentStage ? 'error' : 'pending';
  }
  if (currentStage === 'idle') return 'pending';
  const current = stageRank(currentStage);
  const row = stageRank(rowStage);
  if (current === -1 || row === -1) return 'pending';
  if (row < current) return 'done';
  if (row === current) return 'active';
  return 'pending';
}

function StatusIcon({ status }: { status: RowStatus }): React.JSX.Element {
  switch (status) {
    case 'done':
      return <CheckCircleIcon fontSize='small' sx={{ color: 'success.main' }} />;
    case 'active':
      return <CircularProgress size={18} thickness={5} />;
    case 'error':
      return <CancelIcon fontSize='small' sx={{ color: 'error.main' }} />;
    case 'pending':
    default:
      return <RadioButtonUncheckedIcon fontSize='small' sx={{ color: 'text.disabled' }} />;
  }
}

function StageRow({
  status,
  title,
  detail,
}: {
  status: RowStatus;
  title: string;
  detail?: string;
}): React.JSX.Element {
  return (
    <Stack direction='row' spacing={1.5} alignItems='flex-start' sx={{ py: 0.5 }}>
      <Box sx={{ pt: '3px' }}>
        <StatusIcon status={status} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant='body2'
          sx={{
            fontWeight: status === 'active' ? 600 : 400,
            color: status === 'pending' ? 'text.disabled' : 'text.primary',
          }}
        >
          {title}
        </Typography>
        {detail !== undefined && detail.length > 0 && (
          <Typography variant='caption' sx={{ color: 'text.secondary', display: 'block', wordBreak: 'break-all' }}>
            {detail}
          </Typography>
        )}
      </Box>
    </Stack>
  );
}

export function TiddlyWebCloneProgressDialog({
  open,
  state,
  onClose,
}: TiddlyWebCloneProgressDialogProps): React.JSX.Element {
  const { t } = useTranslation();

  // ── Live first-sync progress ─────────────────────────────────────────────
  // Subscribe once we have the workspaceId. We keep the last event so the row
  // can render `applying` counts even when events stop arriving briefly.
  const [syncEvent, setSyncEvent] = useState<TiddlyWebSyncProgressEvent | undefined>();
  const workspaceId = state.workspaceId;
  useEffect(() => {
    if (!open || workspaceId === undefined) return;
    const subscription = window.observables.tiddlyWebSync.progress$(workspaceId).subscribe({
      next: (event: TiddlyWebSyncProgressEvent) => {
        setSyncEvent(event);
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [open, workspaceId]);

  // Reset sync state whenever the dialog reopens for a fresh clone.
  useEffect(() => {
    if (!open) setSyncEvent(undefined);
  }, [open]);

  // ── Row construction ─────────────────────────────────────────────────────
  const rows = useMemo(() => {
    const { stage, snapshotImported, snapshotSkipReason } = state;

    // Detail lines for each row. The snapshot row shows imported count or skip reason
    // once we've moved past it. The firstSync row reflects whichever phase is live.
    const snapshotDetail = stageRank(stage) > stageRank('downloadingSnapshot')
      ? snapshotSkipReason !== undefined
        ? t('AddWorkspace.TiddlyWebCloneSnapshotSkipped', { reason: snapshotSkipReason })
        : snapshotImported !== undefined
          ? t('AddWorkspace.TiddlyWebCloneSnapshotImported', { count: snapshotImported })
          : undefined
      : undefined;

    const syncDetail = (() => {
      if (stage !== 'firstSync' && stage !== 'done' && stage !== 'error') return undefined;
      if (syncEvent === undefined) return t('AddWorkspace.TiddlyWebCloneSyncStarting');
      switch (syncEvent.phase) {
        case 'started':
          return t('AddWorkspace.TiddlyWebCloneSyncStarting');
        case 'listing-remote':
          return t('AddWorkspace.TiddlyWebCloneSyncListingRemote');
        case 'reading-local':
          return t('AddWorkspace.TiddlyWebCloneSyncReadingLocal');
        case 'reconciled':
          return t('AddWorkspace.TiddlyWebCloneSyncReconciled', {
            pull: syncEvent.summary.pull,
            push: syncEvent.summary.push,
            delete: syncEvent.summary.deleteLocal + syncEvent.summary.deleteRemote,
            conflict: syncEvent.summary.conflict,
          });
        case 'applying':
          // We append the current title separately below; keep this line compact.
          return t('AddWorkspace.TiddlyWebCloneSyncApplying', {
            completed: syncEvent.completed,
            total: syncEvent.total,
          });
        case 'finished':
          return t('AddWorkspace.TiddlyWebCloneSyncFinished', {
            elapsed: Math.round(syncEvent.elapsedMs / 1000),
            errors: syncEvent.errors,
          });
        case 'error':
          return t('AddWorkspace.TiddlyWebCloneSyncErrored', { message: syncEvent.message });
        default:
          return undefined;
      }
    })();

    return [
      {
        key: 'copyingTemplate',
        status: rowStatus('copyingTemplate', stage),
        title: t('AddWorkspace.TiddlyWebCloneStageCreatingLocalWiki'),
      },
      {
        key: 'clearingTiddlers',
        status: rowStatus('clearingTiddlers', stage),
        title: t('AddWorkspace.TiddlyWebCloneStageClearingTiddlers'),
      },
      {
        key: 'downloadingSnapshot',
        status: rowStatus('downloadingSnapshot', stage),
        title: t('AddWorkspace.TiddlyWebCloneStageDownloadingSnapshot'),
        detail: snapshotDetail,
      },
      {
        key: 'registeringWorkspace',
        status: rowStatus('registeringWorkspace', stage),
        title: t('AddWorkspace.TiddlyWebCloneStageRegisteringWorkspace'),
      },
      {
        key: 'startingWiki',
        status: rowStatus('startingWiki', stage),
        title: t('AddWorkspace.TiddlyWebCloneStageStartingWiki'),
      },
      {
        key: 'firstSync',
        // If the sync itself emitted an 'error' phase, surface that even though
        // the renderer-side stage is still 'firstSync'. Makes the red X land
        // on the row that actually failed instead of a generic 'error' state.
        status: syncEvent?.phase === 'error'
          ? 'error' as RowStatus
          : syncEvent?.phase === 'finished'
            ? 'done' as RowStatus
            : rowStatus('firstSync', stage),
        title: t('AddWorkspace.TiddlyWebCloneStageFirstSync'),
        detail: syncDetail,
      },
    ];
  }, [state, syncEvent, t]);

  const busy = state.stage !== 'idle' && state.stage !== 'done' && state.stage !== 'error';

  // ── Top-of-dialog linear progress ────────────────────────────────────────
  // During the long `applying` phase we have hard numbers — show determinate
  // progress. Otherwise indeterminate.
  const applyProgress = syncEvent?.phase === 'applying' && syncEvent.total > 0
    ? Math.min(100, Math.round((syncEvent.completed / syncEvent.total) * 100))
    : undefined;
  const currentTitle = syncEvent?.phase === 'applying' ? syncEvent.currentTitle : undefined;

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      maxWidth='sm'
      fullWidth
      // Disable the escape-key + backdrop-click paths while busy so the user
      // can't accidentally abandon an in-flight clone mid-import.
      disableEscapeKeyDown={busy}
    >
      <DialogTitle>{t('AddWorkspace.TiddlyWebCloneProgressTitle')}</DialogTitle>
      <DialogContent dividers>
        {busy && (
          <Box sx={{ mb: 2 }}>
            <LinearProgress
              variant={applyProgress === undefined ? 'indeterminate' : 'determinate'}
              value={applyProgress}
            />
            {applyProgress !== undefined && (
              <Typography variant='caption' color='text.secondary' sx={{ mt: 0.5, display: 'block' }}>
                {applyProgress}%
                {currentTitle !== undefined && currentTitle.length > 0 && ` — ${currentTitle}`}
              </Typography>
            )}
          </Box>
        )}

        <Stack spacing={0}>
          {rows.map((row) => (
            <StageRow
              key={row.key}
              status={row.status}
              title={row.title}
              detail={row.detail}
            />
          ))}
        </Stack>

        {state.stage === 'error' && state.error !== undefined && (
          <Alert severity='error' sx={{ mt: 2 }}>
            {state.error}
          </Alert>
        )}

        {state.stage === 'done' && (
          <Alert severity='success' sx={{ mt: 2 }}>
            {t('AddWorkspace.TiddlyWebCloneDoneMessage')}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy} variant='contained'>
          {state.stage === 'done'
            ? t('AddWorkspace.TiddlyWebCloneCloseAndOpen')
            : t('Cancel')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
