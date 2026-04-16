import { describe, expect, test } from 'vitest';

import {
  reconcile,
  summarise,
  type LocalTiddlerState,
  type ReconcileInput,
  type RemoteTiddlerState,
  type SyncStateEntry,
} from '../reconciler';

// Tiny helpers — readability matters more than type ceremony in tests.
const local = (entries: Record<string, string>): Map<string, LocalTiddlerState> =>
  new Map(Object.entries(entries).map(([title, hash]) => [title, { hash }]));

const remote = (
  entries: Record<string, { revision: string; bag?: string }>,
): Map<string, RemoteTiddlerState> => new Map(Object.entries(entries));

const state = (entries: Record<string, Omit<SyncStateEntry, 'title'>>): Map<string, SyncStateEntry> =>
  new Map(Object.entries(entries).map(([title, value]) => [title, { title, ...value }]));

const emptyInput: ReconcileInput = {
  local: new Map(),
  remote: new Map(),
  syncState: new Map(),
};

describe('reconcile', () => {
  test('empty input → no actions', () => {
    expect(reconcile(emptyInput)).toEqual([]);
  });

  // ── New tiddlers ────────────────────────────────────────────────────────
  test('local-only, no state → push (new local tiddler)', () => {
    const actions = reconcile({
      ...emptyInput,
      local: local({ A: 'h1' }),
    });
    expect(actions).toEqual([{ type: 'push', title: 'A', localHash: 'h1' }]);
  });

  test('remote-only, no state → pull (new remote tiddler)', () => {
    const actions = reconcile({
      ...emptyInput,
      remote: remote({ A: { revision: 'r1', bag: 'default' } }),
    });
    expect(actions).toEqual([{ type: 'pull', title: 'A', remoteRevision: 'r1', bag: 'default' }]);
  });

  // ── Deletes ─────────────────────────────────────────────────────────────
  test('local-only, with state, local hash unchanged → delete-local (remote was deleted)', () => {
    const actions = reconcile({
      local: local({ A: 'h1' }),
      remote: new Map(),
      syncState: state({ A: { lastKnownRemoteRevision: 'r1', lastSyncedLocalHash: 'h1', lastSyncedAt: 1, bag: 'default' } }),
    });
    expect(actions).toEqual([{ type: 'delete-local', title: 'A' }]);
  });

  test('local-only, with state, local hash changed → push (recreate on server)', () => {
    const actions = reconcile({
      local: local({ A: 'h2' }),
      remote: new Map(),
      syncState: state({ A: { lastKnownRemoteRevision: 'r1', lastSyncedLocalHash: 'h1', lastSyncedAt: 1, bag: 'default' } }),
    });
    expect(actions).toEqual([{ type: 'push', title: 'A', localHash: 'h2' }]);
  });

  test('remote-only, with state, remote rev unchanged → delete-remote', () => {
    const actions = reconcile({
      local: new Map(),
      remote: remote({ A: { revision: 'r1', bag: 'default' } }),
      syncState: state({ A: { lastKnownRemoteRevision: 'r1', lastSyncedLocalHash: 'h1', lastSyncedAt: 1, bag: 'default' } }),
    });
    expect(actions).toEqual([{ type: 'delete-remote', title: 'A', bag: 'default', baseRevision: 'r1' }]);
  });

  test('remote-only, with state, remote rev changed → pull (server wins, restore locally)', () => {
    const actions = reconcile({
      local: new Map(),
      remote: remote({ A: { revision: 'r2', bag: 'default' } }),
      syncState: state({ A: { lastKnownRemoteRevision: 'r1', lastSyncedLocalHash: 'h1', lastSyncedAt: 1, bag: 'default' } }),
    });
    expect(actions).toEqual([{ type: 'pull', title: 'A', remoteRevision: 'r2', bag: 'default' }]);
  });

  test('both gone, state remains → clear-sync-state', () => {
    const actions = reconcile({
      local: new Map(),
      remote: new Map(),
      syncState: state({ A: { lastKnownRemoteRevision: 'r1', lastSyncedLocalHash: 'h1', lastSyncedAt: 1 } }),
    });
    expect(actions).toEqual([{ type: 'clear-sync-state', title: 'A' }]);
  });

  // ── Both sides exist, no prior state (first sync) ───────────────────────
  test('both sides exist, no state → pull with backupLocal', () => {
    const actions = reconcile({
      local: local({ A: 'h1' }),
      remote: remote({ A: { revision: 'r1', bag: 'default' } }),
      syncState: new Map(),
    });
    expect(actions).toEqual([
      { type: 'pull', title: 'A', remoteRevision: 'r1', bag: 'default', backupLocal: true },
    ]);
  });

  // ── Both sides exist, with state ────────────────────────────────────────
  test('both unchanged → no action', () => {
    const actions = reconcile({
      local: local({ A: 'h1' }),
      remote: remote({ A: { revision: 'r1' } }),
      syncState: state({ A: { lastKnownRemoteRevision: 'r1', lastSyncedLocalHash: 'h1', lastSyncedAt: 1 } }),
    });
    expect(actions).toEqual([]);
  });

  test('only remote changed → pull', () => {
    const actions = reconcile({
      local: local({ A: 'h1' }),
      remote: remote({ A: { revision: 'r2', bag: 'default' } }),
      syncState: state({ A: { lastKnownRemoteRevision: 'r1', lastSyncedLocalHash: 'h1', lastSyncedAt: 1 } }),
    });
    expect(actions).toEqual([{ type: 'pull', title: 'A', remoteRevision: 'r2', bag: 'default' }]);
  });

  test('only local changed → push with baseRevision', () => {
    const actions = reconcile({
      local: local({ A: 'h2' }),
      remote: remote({ A: { revision: 'r1' } }),
      syncState: state({ A: { lastKnownRemoteRevision: 'r1', lastSyncedLocalHash: 'h1', lastSyncedAt: 1 } }),
    });
    expect(actions).toEqual([{ type: 'push', title: 'A', localHash: 'h2', baseRevision: 'r1' }]);
  });

  test('both changed → conflict-backup-local', () => {
    const actions = reconcile({
      local: local({ A: 'h2' }),
      remote: remote({ A: { revision: 'r2', bag: 'default' } }),
      syncState: state({ A: { lastKnownRemoteRevision: 'r1', lastSyncedLocalHash: 'h1', lastSyncedAt: 1 } }),
    });
    expect(actions).toEqual([
      { type: 'conflict-backup-local', title: 'A', remoteRevision: 'r2', localHash: 'h2', bag: 'default' },
    ]);
  });

  // ── Mixed scenarios ─────────────────────────────────────────────────────
  test('mixed: pull, push, conflict, delete in one pass', () => {
    const actions = reconcile({
      local: local({
        Pulled: 'old',     // unchanged locally; remote moved → pull
        Pushed: 'newLocal',// changed locally; remote unchanged → push
        Conflict: 'newL',  // both changed
        DeletedLocally: 'h1',// remote-only with state → was actually local-deleted? No — we have it locally.
      }),
      remote: remote({
        Pulled: { revision: 'r2' },
        Pushed: { revision: 'r1' },
        Conflict: { revision: 'r2', bag: 'default' },
        New: { revision: 'r1' },
      }),
      syncState: state({
        Pulled: { lastKnownRemoteRevision: 'r1', lastSyncedLocalHash: 'old', lastSyncedAt: 1 },
        Pushed: { lastKnownRemoteRevision: 'r1', lastSyncedLocalHash: 'oldLocal', lastSyncedAt: 1 },
        Conflict: { lastKnownRemoteRevision: 'r1', lastSyncedLocalHash: 'oldL', lastSyncedAt: 1 },
        DeletedLocally: { lastKnownRemoteRevision: 'r1', lastSyncedLocalHash: 'h1', lastSyncedAt: 1 },
      }),
    });

    // Sorted alphabetically: Conflict, DeletedLocally, New, Pulled, Pushed
    expect(actions).toEqual([
      { type: 'conflict-backup-local', title: 'Conflict', remoteRevision: 'r2', localHash: 'newL', bag: 'default' },
      // DeletedLocally has L=1, R=0, S=1, local hash matches state → would mean
      // remote was deleted while local untouched. But we put it in `local` so
      // L=1; R=0; that means remote deleted, local hash equals state → delete-local.
      { type: 'delete-local', title: 'DeletedLocally' },
      { type: 'pull', title: 'New', remoteRevision: 'r1' },
      { type: 'pull', title: 'Pulled', remoteRevision: 'r2' },
      { type: 'push', title: 'Pushed', localHash: 'newLocal', baseRevision: 'r1' },
    ]);
  });

  test('output is sorted by title for determinism', () => {
    const actions = reconcile({
      local: local({ Z: 'h', A: 'h', M: 'h' }),
      remote: new Map(),
      syncState: new Map(),
    });
    expect(actions.map((a) => 'title' in a ? a.title : '')).toEqual(['A', 'M', 'Z']);
  });

  test('remote bag is preserved through pull and delete-remote', () => {
    const actions = reconcile({
      local: new Map(),
      remote: remote({ A: { revision: 'r1', bag: 'specialBag' } }),
      syncState: state({ A: { lastKnownRemoteRevision: 'r1', lastSyncedLocalHash: 'h1', lastSyncedAt: 1, bag: 'oldBag' } }),
    });
    // Remote rev unchanged → delete-remote, and we prefer the live remote bag over the stored one.
    expect(actions).toEqual([{ type: 'delete-remote', title: 'A', bag: 'specialBag', baseRevision: 'r1' }]);
  });

  test('local-only push for new tiddler does not include baseRevision', () => {
    const actions = reconcile({
      local: local({ Brand: 'h1' }),
      remote: new Map(),
      syncState: new Map(),
    });
    expect(actions[0]).not.toHaveProperty('baseRevision');
  });
});

describe('summarise', () => {
  test('counts each action type', () => {
    const summary = summarise([
      { type: 'pull', title: 'A', remoteRevision: 'r1' },
      { type: 'pull', title: 'B', remoteRevision: 'r1' },
      { type: 'push', title: 'C', localHash: 'h1' },
      { type: 'delete-local', title: 'D' },
      { type: 'delete-remote', title: 'E', baseRevision: 'r1' },
      { type: 'conflict-backup-local', title: 'F', remoteRevision: 'r1', localHash: 'h1' },
      { type: 'clear-sync-state', title: 'G' },
    ]);
    expect(summary).toEqual({
      pull: 2,
      push: 1,
      deleteLocal: 1,
      deleteRemote: 1,
      conflict: 1,
      clearState: 1,
      total: 7,
    });
  });

  test('empty input', () => {
    expect(summarise([])).toEqual({
      pull: 0,
      push: 0,
      deleteLocal: 0,
      deleteRemote: 0,
      conflict: 0,
      clearState: 0,
      total: 0,
    });
  });
});
