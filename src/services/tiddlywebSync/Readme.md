# TiddlyWebSync — HTTP sync between TidGi Desktop and a NodeJS TiddlyWiki server

This service synchronises a TidGi workspace's tiddler store with a remote
TiddlyWiki NodeJS server using its TiddlyWeb-compatible REST API. It is a
sibling of the existing Git-based sync service (`@services/sync`) and is
selected per-workspace via `storageService === 'tiddlyweb'`.

It targets self-hosted TW NodeJS servers (`tiddlywiki <wiki> --listen`) or
hosted services that expose the TiddlyWeb interface (e.g. TiddlyHost).

---

## When to use this vs Git sync

| | Git sync | TiddlyWeb sync |
|---|---|---|
| Conflict granularity | Whole-file (TID/JSON) | Per-tiddler |
| Latency | Manual / interval (commit + push) | Near-realtime (interval ~30 s) |
| Server requirement | Any Git host | A running TW NodeJS server |
| Editing on multiple devices simultaneously | Manual merging | Auto with backup of loser |
| Network needed | Only at sync time | Constant for low latency |

Git sync stays the right answer for asynchronous, multi-device editing where
each user works mostly on one device at a time. TiddlyWeb sync is better when
you have a personal server you want to use as a single source of truth and
you'd like changes to propagate within seconds.

---

## Architecture

```
┌─────────────────┐  syncWorkspace()  ┌────────────────────────────────┐
│  Sync service   │ ────────────────▶ │ TiddlyWebSync service          │
│  (interval +    │                   │  ┌──────────────────────────┐  │
│   manual)       │                   │  │  per-workspace mutex     │  │
└─────────────────┘                   │  └──────────────────────────┘  │
                                      │      │                         │
                                      │      ▼                         │
                                      │  reconcile()  (pure)           │
                                      │      ▲                         │
                              ┌───────┼──────┼───────────┬────────┐    │
                              │       │      │           │        │    │
                       ┌──────┴──┐ ┌──┴──┐ ┌─┴────────┐ ┌▼──────┐ │    │
                       │ Wiki    │ │ HTTP│ │ State    │ │ Hash  │ │    │
                       │ worker  │ │client│ │ store    │ │ util  │ │    │
                       │ (local  │ │(remote)│ │(JSON file│ │       │ │    │
                       │ tiddlers)│ │      │ │ per ws)  │ │       │ │    │
                       └─────────┘ └──────┘ └──────────┘ └───────┘ │    │
                                                                   ┘    │
                                      └────────────────────────────────┘
```

### Files

| File | Role |
|------|------|
| `client.ts` | HTTP client for `/recipes/.../tiddlers[.json]` and `/bag/.../tiddlers/...`. |
| `reconciler.ts` | Pure three-way merge: emits `pull` / `push` / `delete-*` / `conflict-backup-local` actions. |
| `hash.ts` | Stable content hash used as the "local revision" for change detection. |
| `stateStore.ts` | Per-workspace JSON file holding `{ title → (lastKnownRemoteRevision, lastSyncedLocalHash) }`. |
| `interface.ts` | Public IPC interface, progress events, status types. |
| `index.ts` | Service: glues all the above together; one in-flight sync per workspace. |

### Three-way merge

For every tiddler title that appears in either local, remote, or sync state,
the reconciler decides one of:

- `pull` — fetch remote and write locally; first-sync includes a `backupLocal` flag.
- `push` — PUT local content to remote.
- `delete-local` — local copy must go (remote was deleted while local hadn't changed).
- `delete-remote` — server copy must go (local deleted while remote hadn't changed).
- `conflict-backup-local` — both sides moved since last sync; save local copy
  to `$:/sync/conflicts/<title>/<timestamp>` then overwrite with remote.
- `clear-sync-state` — both sides gone; just clean up the bookkeeping row.

Decision matrix is in the JSDoc at the top of `reconciler.ts`.

### Conflict resolution policy: server-wins-with-backup

When the same tiddler is changed on both sides between syncs, the remote copy
wins and the pre-overwrite local copy is saved to a tagged backup tiddler so
nothing is silently lost. Same policy applies on **first sync** for any
tiddler that already exists on both sides — we treat the server as source of
truth but keep a backup.

Backups land at `$:/sync/conflicts/<original-title>/<ISO-timestamp>` and are
tagged `$:/sync/conflict-backup` for easy discovery.

### State storage

`stateStore.ts` writes a small JSON file per workspace at:

    <userData>/cache-database/tiddlyweb-sync-state/<workspaceId>.json

Format:

```json
{
  "schemaVersion": 1,
  "remoteFingerprint": "https://wiki.example.com|default",
  "lastFullSyncAt": 1716000000000,
  "entries": {
    "Foo": {
      "lastKnownRemoteRevision": "5",
      "lastSyncedLocalHash": "9a8b...",
      "lastSyncedAt": 1715999999000,
      "bag": "default"
    }
  }
}
```

If `remoteFingerprint` (server URL + recipe) changes, the store automatically
resets — old revisions are meaningless against a different server.

---

## Workspace configuration

Adding a TiddlyWeb workspace requires these fields on `IWikiWorkspace`:

| Field | Default | Description |
|---|---|---|
| `storageService` | `'local'` | Set to `'tiddlyweb'` to enable HTTP sync. |
| `tiddlywebUrl` | `null` | Base URL of the TW server, e.g. `https://wiki.example.com`. **No trailing slash.** |
| `tiddlywebRecipe` | `'default'` | Recipe name. The default install uses `default`. |
| `tiddlywebUsername` | `''` | Basic auth username (empty = unauthenticated). |
| `tiddlywebSyncIntervalMs` | `30_000` | Auto-sync interval in ms. Min ~5000 in practice. |
| `tiddlywebExcludeFilter` | `'[prefix[$:/]]'` | TW filter expression. Tiddlers matching this are NOT synced. Default excludes all `$:/` system tiddlers (config / state / plugins). |

The basic-auth password is stored in the keychain via the auth service under
the key `tiddlyweb-token` (one shared password across tiddlyweb workspaces, in
keeping with how `*-token` keys work for other storage services).

These fields are also part of `syncableConfig` so they ride along in the
wiki's `tidgi.config.json` when sharing the wiki between devices.

---

## Server setup

1. On the server, install TiddlyWiki and create a wiki:

   ```sh
   npm install -g tiddlywiki
   tiddlywiki MyWiki --init server
   ```

2. (Recommended) configure auth in `MyWiki/tiddlywiki.info` so PUT/DELETE
   require credentials, e.g. via Basic auth or a reverse proxy with HTTPS.

3. Run the server, exposing the port:

   ```sh
   tiddlywiki MyWiki --listen host=0.0.0.0 port=8080 \
     username=alice password=$WIKI_PASSWORD
   ```

4. In TidGi: add a workspace, set Storage = TiddlyWeb, fill in
   `tiddlywebUrl=https://your.host:8080`, username, and password.
   Test the connection from the workspace settings panel.

⚠️ **Always front the TW server with HTTPS** if it's reachable from anywhere
that isn't your local network. Basic auth over plaintext leaks the password.

---

## Failure modes & how the code handles them

| Symptom | Behaviour |
|---|---|
| Server unreachable | Sync throws; `lastError` populated; next interval retries. |
| 401/403 | Same as above; user sees the error in the UI. |
| Single tiddler PUT fails (e.g. 409) | That action is recorded in `errors[]`; the rest of the pass continues. |
| Crash mid-write of state file | Atomic temp+rename leaves the previous file intact. |
| User points workspace at a different server | `ensureFingerprint` resets state; next sync is treated as first-sync. |
| Server returns body without `title` field | `client.fetchOne` re-injects from the URL. (Was a real silent data-loss bug.) |
| Tiddler title with `/`, `:`, `$`, spaces | `encodeURIComponent` everywhere; verified by client tests. |

---

## Performance notes

- One sync pass = 1 list call + N fetch calls (for pulls) + M put/delete
  calls (for pushes/deletes). Listing returns summaries only (no `text`),
  so it's cheap even for thousands of tiddlers.
- Local snapshot uses `getTiddlersAsJson` once. For very large wikis
  (>20k tiddlers or huge text bodies) this is the dominant cost; a future
  optimisation could fetch only the diff against last-known hashes.
- Actions are applied serially per workspace. The TW wiki worker is
  single-threaded for mutations and serial PUTs avoid race conditions on the
  server side. We don't currently parallelise.

---

## Testing

```sh
pnpm test:unit src/services/tiddlywebSync
```

Covers:

- All decision-matrix branches in `reconciler.test.ts`.
- Hash stability and metadata exclusion in `hash.test.ts`.
- URL encoding, header injection, etag parsing, missing-title fallback in
  `client.test.ts`.

---

## Future work

- UI panel: progress indicator + last-sync time + "Sync now" button + reset
  state button. (`progress$` observable and `getStatus()` are ready.)
- Diff-based local snapshot for large wikis.
- Configurable conflict resolution policy (currently hardcoded to
  server-wins-with-backup).
- Support for TiddlyWiki 5.4+ multi-bag recipes properly (we currently fall
  back to the recipe name as the bag for delete URLs).
- Push token / OAuth (right now only HTTP Basic auth is supported).
