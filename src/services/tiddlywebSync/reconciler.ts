/**
 * Pure three-way merge reconciler for TiddlyWeb sync.
 *
 * Given a snapshot of:
 *   - `local`: current local tiddlers (keyed by title, value = content hash)
 *   - `remote`: current remote tiddlers (from /tiddlers.json; value = revision + bag)
 *   - `syncState`: the record of what we knew at the end of the previous successful sync
 *
 * this function decides what actions to take. It is pure — no I/O, no mutation.
 * The sync service executes the returned actions against the HTTP client and the
 * local tiddler store.
 *
 * ### Identity and versions
 * - Tiddler title is the identity.
 * - Remote version is the opaque `revision` string returned by TW server (monotonic per tiddler).
 * - Local version is a stable content hash we compute locally (see hash.ts).
 *
 * ### Decision table (L=in local, R=in remote, S=in sync state)
 *
 * | L | R | S | sub-condition                                | action                  |
 * |---|---|---|----------------------------------------------|-------------------------|
 * | 0 | 0 | 1 | gone from both, cleanup                      | clear-sync-state        |
 * | 0 | 1 | 0 | new on remote                                | pull                    |
 * | 0 | 1 | 1 | deleted locally, remote rev unchanged        | delete-remote           |
 * | 0 | 1 | 1 | deleted locally, remote rev changed          | pull (remote wins)      |
 * | 1 | 0 | 0 | new locally                                  | push                    |
 * | 1 | 0 | 1 | remote deleted, local unchanged              | delete-local            |
 * | 1 | 0 | 1 | remote deleted, local changed                | push (local wins)       |
 * | 1 | 1 | 0 | first sync, both exist                       | pull + backupLocal flag |
 * | 1 | 1 | 1 | both unchanged                               | (skip)                  |
 * | 1 | 1 | 1 | only remote changed                          | pull                    |
 * | 1 | 1 | 1 | only local changed                           | push                    |
 * | 1 | 1 | 1 | both changed                                 | conflict-backup-local   |
 *
 * ### Conflict policy
 * On true three-way conflict we default to **server wins with local backup**:
 * the executor should write a tiddler `$:/sync/conflict-backups/<title>/<ts>`
 * containing the pre-overwrite local content, then overwrite with the server copy.
 * This never silently loses data.
 *
 * ### First-sync policy
 * For `L && R && !S` we emit `pull` with `backupLocal: true`. The executor only
 * actually creates a backup if the pulled content differs from the current local
 * content (to avoid noise on identical tiddlers shipped by a starter).
 */

export interface LocalTiddlerState {
  /** Stable hash of the tiddler's content (title + text + tags + user fields; no `modified`/`revision`). */
  hash: string;
}

export interface RemoteTiddlerState {
  revision: string;
  bag?: string;
}

export interface SyncStateEntry {
  title: string;
  /** Remote `revision` observed at end of last successful sync. */
  lastKnownRemoteRevision: string;
  /** Local content hash at end of last successful sync. */
  lastSyncedLocalHash: string;
  /** Epoch milliseconds of last successful sync for this tiddler. */
  lastSyncedAt: number;
  /** Bag name reported by server, needed to construct DELETE URL. */
  bag?: string;
}

/**
 * Actions the reconciler can emit. Each action targets exactly one tiddler
 * (by title) and is independent of the others, so the executor can parallelise
 * freely. Ordering is only meaningful within a title, and we only ever emit
 * one action per title.
 */
export type SyncAction =
  | {
    type: 'pull';
    title: string;
    remoteRevision: string;
    bag?: string;
    /**
     * If true, the executor should compare pulled content against current
     * local content and save a conflict backup if they differ. Used on
     * first-sync so the server's copy does not silently clobber local work.
     */
    backupLocal?: boolean;
  }
  | {
    type: 'push';
    title: string;
    localHash: string;
    /** Revision we expect to be on the server. Undefined = this is a create. */
    baseRevision?: string;
  }
  | { type: 'delete-local'; title: string }
  | {
    type: 'delete-remote';
    title: string;
    bag?: string;
    /** Revision we expect to delete. */
    baseRevision: string;
  }
  | {
    /** True three-way conflict: back up local, then pull remote. */
    type: 'conflict-backup-local';
    title: string;
    remoteRevision: string;
    localHash: string;
    bag?: string;
  }
  | { type: 'clear-sync-state'; title: string };

export interface ReconcileInput {
  local: Map<string, LocalTiddlerState>;
  remote: Map<string, RemoteTiddlerState>;
  syncState: Map<string, SyncStateEntry>;
}

export function reconcile(input: ReconcileInput): SyncAction[] {
  const { local, remote, syncState } = input;
  const actions: SyncAction[] = [];

  // Union of all titles touching any of the three sides.
  const titles = new Set<string>();
  for (const t of local.keys()) titles.add(t);
  for (const t of remote.keys()) titles.add(t);
  for (const t of syncState.keys()) titles.add(t);

  // Sort for deterministic output (easier testing / logs).
  const sorted = [...titles].sort();

  for (const title of sorted) {
    const L = local.get(title);
    const R = remote.get(title);
    const S = syncState.get(title);

    // === Neither side has it ===
    if (!L && !R) {
      // Only way to get here is S is set. Clean up stale state.
      if (S !== undefined) actions.push({ type: 'clear-sync-state', title });
      continue;
    }

    // === Only remote has it ===
    if (!L && R) {
      if (!S) {
        actions.push({ type: 'pull', title, remoteRevision: R.revision, bag: R.bag });
      } else if (R.revision === S.lastKnownRemoteRevision) {
        // Local deleted, remote untouched since last sync → propagate delete.
        actions.push({
          type: 'delete-remote',
          title,
          bag: R.bag ?? S.bag,
          baseRevision: R.revision,
        });
      } else {
        // Local deleted BUT remote also moved → don't silently re-delete the
        // server's newer content. Restore it locally (server wins).
        actions.push({ type: 'pull', title, remoteRevision: R.revision, bag: R.bag });
      }
      continue;
    }

    // === Only local has it ===
    if (L && !R) {
      if (!S) {
        // Brand-new local tiddler.
        actions.push({ type: 'push', title, localHash: L.hash });
      } else if (L.hash === S.lastSyncedLocalHash) {
        // Remote was deleted, local hasn't changed → mirror the delete.
        actions.push({ type: 'delete-local', title });
      } else {
        // Remote was deleted, but user edited locally since. Recreate on server.
        actions.push({ type: 'push', title, localHash: L.hash });
      }
      continue;
    }

    // === Both sides have it ===
    // (Non-null here because of the !L/!R branches above.)
    const remoteState = R as RemoteTiddlerState;
    const localState = L as LocalTiddlerState;

    if (!S) {
      // First sync and both already have a copy. Server wins but we ask the
      // executor to stash local as a conflict backup if contents differ.
      actions.push({
        type: 'pull',
        title,
        remoteRevision: remoteState.revision,
        bag: remoteState.bag,
        backupLocal: true,
      });
      continue;
    }

    const remoteChanged = remoteState.revision !== S.lastKnownRemoteRevision;
    const localChanged = localState.hash !== S.lastSyncedLocalHash;

    if (!remoteChanged && !localChanged) {
      // Clean, no-op. No action.
      continue;
    }

    if (remoteChanged && !localChanged) {
      actions.push({
        type: 'pull',
        title,
        remoteRevision: remoteState.revision,
        bag: remoteState.bag,
      });
      continue;
    }

    if (!remoteChanged && localChanged) {
      actions.push({
        type: 'push',
        title,
        localHash: localState.hash,
        baseRevision: S.lastKnownRemoteRevision,
      });
      continue;
    }

    // Both sides moved since last sync → conflict.
    actions.push({
      type: 'conflict-backup-local',
      title,
      remoteRevision: remoteState.revision,
      localHash: localState.hash,
      bag: remoteState.bag,
    });
  }

  return actions;
}

/**
 * Summary stats for logging / UI progress display.
 */
export interface ReconcileSummary {
  pull: number;
  push: number;
  deleteLocal: number;
  deleteRemote: number;
  conflict: number;
  clearState: number;
  total: number;
}

export function summarise(actions: SyncAction[]): ReconcileSummary {
  const s: ReconcileSummary = {
    pull: 0,
    push: 0,
    deleteLocal: 0,
    deleteRemote: 0,
    conflict: 0,
    clearState: 0,
    total: actions.length,
  };
  for (const a of actions) {
    switch (a.type) {
      case 'pull':
        s.pull += 1;
        break;
      case 'push':
        s.push += 1;
        break;
      case 'delete-local':
        s.deleteLocal += 1;
        break;
      case 'delete-remote':
        s.deleteRemote += 1;
        break;
      case 'conflict-backup-local':
        s.conflict += 1;
        break;
      case 'clear-sync-state':
        s.clearState += 1;
        break;
    }
  }
  return s;
}
