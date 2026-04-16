/**
 * Public interface for the TiddlyWebSync service.
 *
 * This service synchronises a TidGi workspace's tiddler store with a remote
 * TiddlyWiki NodeJS server (TiddlyWeb-compatible REST API). It is the
 * counterpart to the Git-based sync for users who run their own self-hosted
 * TiddlyWiki server instead of pushing to a Git remote.
 *
 * Architecturally it is a sibling of `ISyncService` (Git-based) and is invoked
 * via the same entry point (`Sync.syncWikiIfNeeded`) when a workspace's
 * `storageService === 'tiddlyweb'`.
 *
 * The renderer talks to this over IPC for UI actions (test connection, manual
 * sync now, view stats); periodic sync is driven from the main process.
 */

import { TiddlyWebSyncChannel } from '@/constants/channels';
import { ProxyPropertyType } from 'electron-ipc-cat/common';
import type { Observable } from 'rxjs';
import type { ReconcileSummary } from './reconciler';

export interface ITiddlyWebSyncService {
  /**
   * Run a single sync pass for the given workspace.
   *
   * Idempotent: if there is already a sync in flight for this workspace, this
   * call awaits the in-flight one rather than starting a new one. This makes
   * it safe to call from both the timer and a user-initiated "sync now".
   *
   * @returns summary of actions taken, or undefined if the workspace is not a
   *          tiddlyweb workspace or is misconfigured.
   */
  syncWorkspace(workspaceId: string): Promise<TiddlyWebSyncResult | undefined>;

  /**
   * Health check: verify the workspace's configured TiddlyWeb server is
   * reachable and authentication (if any) is accepted.
   */
  testConnection(workspaceId: string): Promise<TiddlyWebConnectionResult>;

  /**
   * Drop all stored sync state for the workspace. Next sync will be treated as
   * a first-sync (server-wins with local-backup-on-conflict).
   */
  resetSyncState(workspaceId: string): Promise<void>;

  /**
   * Get summary stats for the UI: count, last sync time, last error.
   */
  getStatus(workspaceId: string): Promise<TiddlyWebSyncStatus>;

  /**
   * Stream of progress events the renderer can subscribe to in order to render
   * a live indicator during a sync pass.
   */
  progress$(workspaceId: string): Observable<TiddlyWebSyncProgressEvent>;
}

export interface TiddlyWebSyncResult {
  workspaceId: string;
  startedAt: number;
  finishedAt: number;
  summary: ReconcileSummary;
  /** Per-action errors. The sync continues past per-tiddler failures so a single bad item doesn't block everything. */
  errors: Array<{ title: string; action: string; message: string }>;
}

export interface TiddlyWebConnectionResult {
  reachable: boolean;
  /** Server reports its version when /status returns successfully. */
  serverInfo?: {
    /** TW core version, or undefined if not exposed. */
    tiddlywikiVersion?: string;
    username?: string;
  };
  error?: string;
}

export interface TiddlyWebSyncStatus {
  workspaceId: string;
  configured: boolean;
  trackedTiddlerCount: number;
  lastFullSyncAt: number | undefined;
  lastError?: string;
  inFlight: boolean;
}

export type TiddlyWebSyncProgressEvent =
  | { phase: 'started'; workspaceId: string }
  | { phase: 'listing-remote'; workspaceId: string }
  | { phase: 'reading-local'; workspaceId: string }
  | {
    phase: 'reconciled';
    workspaceId: string;
    summary: ReconcileSummary;
  }
  | {
    phase: 'applying';
    workspaceId: string;
    completed: number;
    total: number;
    /** Title of the tiddler currently being processed (for status text). */
    currentTitle?: string;
  }
  | {
    phase: 'finished';
    workspaceId: string;
    summary: ReconcileSummary;
    errors: number;
    elapsedMs: number;
  }
  | { phase: 'error'; workspaceId: string; message: string };

export const TiddlyWebSyncServiceIPCDescriptor = {
  channel: TiddlyWebSyncChannel.name,
  properties: {
    syncWorkspace: ProxyPropertyType.Function,
    testConnection: ProxyPropertyType.Function,
    resetSyncState: ProxyPropertyType.Function,
    getStatus: ProxyPropertyType.Function,
    progress$: ProxyPropertyType.Function$,
  },
};
