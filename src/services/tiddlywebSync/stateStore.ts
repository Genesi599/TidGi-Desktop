/**
 * Per-workspace sync-state store for TiddlyWeb sync.
 *
 * What this tracks:
 *   - For each tiddler title we've ever successfully synced, the last-seen
 *     remote revision and the local content hash at that time. The reconciler
 *     uses these to distinguish "unchanged" from "changed" on each side.
 *   - Free-form metadata (`lastFullSyncAt`, schema version, etc.)
 *
 * Why a JSON file (and not SQLite):
 *   - State is small: one row per tiddler, ~100 bytes. Even a huge wiki (50k
 *     tiddlers) stays under ~5MB. Loading it all into memory is cheap and makes
 *     the reconciler's map-lookups O(1) without I/O.
 *   - Easy to inspect / delete manually when debugging.
 *   - No schema migration burden: it's just a JSON file; if we change the
 *     shape we can bump `schemaVersion` and reset stale entries.
 *   - No extra DB connection per workspace to manage.
 *
 * Atomicity: writes go through fs.writeFile on a temp path + rename, so a
 * crash mid-write leaves the previous file intact.
 *
 * Concurrency: there's a `writeQueue` so concurrent `save()` calls serialise.
 * The service layer is also expected to only run one sync per workspace at a
 * time (see the sync service for the mutex).
 */

import fs from 'fs-extra';
import path from 'path';

import { CACHE_DATABASE_FOLDER } from '@/constants/appPaths';
import { logger } from '@services/libs/log';
import type { SyncStateEntry } from './reconciler';

const SCHEMA_VERSION = 1;
const STATE_FOLDER_NAME = 'tiddlyweb-sync-state';

interface StateFile {
  schemaVersion: number;
  /**
   * Server base URL + recipe. Stored so we can reset state automatically when
   * the user points the workspace at a different server (old revisions would
   * be meaningless).
   */
  remoteFingerprint?: string;
  /** Epoch ms of last successful full-sync pass. */
  lastFullSyncAt?: number;
  /** Sync state per tiddler, keyed by title. */
  entries: Record<string, Omit<SyncStateEntry, 'title'>>;
}

export function stateFilePathFor(workspaceId: string): string {
  return path.resolve(CACHE_DATABASE_FOLDER, STATE_FOLDER_NAME, `${workspaceId}.json`);
}

export class TiddlyWebSyncStateStore {
  private entries = new Map<string, SyncStateEntry>();
  private lastFullSyncAt: number | undefined;
  private remoteFingerprint: string | undefined;
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(public readonly workspaceId: string, private readonly filePath = stateFilePathFor(workspaceId)) {}

  /**
   * Load state from disk. Safe to call multiple times (no-op after first).
   * If the file is missing or corrupted, starts with empty state.
   */
  public async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!(await fs.pathExists(this.filePath))) {
        return;
      }
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as StateFile;
      if (parsed.schemaVersion !== SCHEMA_VERSION) {
        logger.warn(
          `TiddlyWebSyncStateStore: schema version mismatch (file=${parsed.schemaVersion}, code=${SCHEMA_VERSION}). Resetting state for workspace ${this.workspaceId}.`,
        );
        return;
      }
      this.remoteFingerprint = parsed.remoteFingerprint;
      this.lastFullSyncAt = parsed.lastFullSyncAt;
      this.entries = new Map(
        Object.entries(parsed.entries ?? {}).map(([title, value]) => [title, { title, ...value }]),
      );
    } catch (error) {
      logger.error(`TiddlyWebSyncStateStore: failed to load state for ${this.workspaceId}, starting fresh`, { error });
      this.entries = new Map();
    }
  }

  /**
   * Persist state to disk atomically (write-to-temp + rename).
   * Serialised via an internal queue so overlapping calls don't corrupt the file.
   */
  public save(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.ensureDir(path.dirname(this.filePath));
      const data: StateFile = {
        schemaVersion: SCHEMA_VERSION,
        remoteFingerprint: this.remoteFingerprint,
        lastFullSyncAt: this.lastFullSyncAt,
        entries: Object.fromEntries(
          [...this.entries.entries()].map(([title, entry]) => {
            const { title: _t, ...rest } = entry;
            return [title, rest];
          }),
        ),
      };
      const tmpPath = `${this.filePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(data), 'utf8');
      await fs.move(tmpPath, this.filePath, { overwrite: true });
    }).catch((error: unknown) => {
      logger.error(`TiddlyWebSyncStateStore: save failed for ${this.workspaceId}`, { error });
      // Reset the queue so the next call can attempt a fresh write rather than
      // forever-reject via the poisoned tail.
    });
    return this.writeQueue;
  }

  /**
   * Return a *copy* of the current state map. The reconciler mutates nothing
   * in this store directly; updates come back through `applyUpdates()`.
   */
  public all(): Map<string, SyncStateEntry> {
    this.assertLoaded();
    return new Map(this.entries);
  }

  public get(title: string): SyncStateEntry | undefined {
    this.assertLoaded();
    return this.entries.get(title);
  }

  public upsert(entry: SyncStateEntry): void {
    this.assertLoaded();
    this.entries.set(entry.title, entry);
  }

  public deleteEntry(title: string): void {
    this.assertLoaded();
    this.entries.delete(title);
  }

  public clearAll(): void {
    this.assertLoaded();
    this.entries.clear();
    this.lastFullSyncAt = undefined;
  }

  public getLastFullSyncAt(): number | undefined {
    return this.lastFullSyncAt;
  }

  public setLastFullSyncAt(timestamp: number): void {
    this.lastFullSyncAt = timestamp;
  }

  public getRemoteFingerprint(): string | undefined {
    return this.remoteFingerprint;
  }

  /**
   * If the stored fingerprint differs from the given one, wipes all entries
   * (the old revisions are meaningless for a different server). Returns true
   * if state was reset.
   */
  public ensureFingerprint(fingerprint: string): boolean {
    this.assertLoaded();
    if (this.remoteFingerprint === fingerprint) return false;
    if (this.remoteFingerprint !== undefined) {
      logger.info(
        `TiddlyWebSyncStateStore: remote fingerprint changed for ${this.workspaceId}; resetting state. old=${this.remoteFingerprint} new=${fingerprint}`,
      );
      this.entries.clear();
      this.lastFullSyncAt = undefined;
    }
    this.remoteFingerprint = fingerprint;
    return true;
  }

  public size(): number {
    return this.entries.size;
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error('TiddlyWebSyncStateStore: load() must be called before use');
    }
  }
}
