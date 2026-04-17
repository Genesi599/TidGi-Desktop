/**
 * Extract sync-state seed entries from a TiddlyWiki snapshot dump.
 *
 * Context: when cloning from a TiddlyWeb server, we download the server's root
 * HTML and use `tiddlywiki --savewikifolder` to explode it into per-tiddler
 * `.tid` / `.json` files under `tiddlers/`. Server-loaded tiddlers carry a
 * `revision` field that TW preserves during that save. By pulling
 * `(title, revision, bag)` out of each file, we can pre-seed the sync service's
 * state store so the first sync can skip 18k+ redundant HTTP pulls.
 *
 * This module is pure string/JSON parsing — it does no I/O itself. The caller
 * reads each file and hands the contents here. Keeps the logic trivially
 * testable and reusable.
 */

export interface SnapshotSeedEntry {
  title: string;
  revision: string;
  bag?: string;
}

/**
 * Parse a `.tid` file (TW's single-tiddler text format).
 *
 * Format:
 *   field: value\n   ← one header line per field
 *   field: value\n
 *   \n               ← blank line separates header from body
 *   body text...
 *
 * We only care about `title`, `revision`, `bag`. Returns undefined if the file
 * has no usable title/revision pair (e.g. a plain text tiddler that was never
 * on a server).
 */
export function parseTidSeed(content: string): SnapshotSeedEntry | undefined {
  // Find the first blank line (\r\n\r\n or \n\n) — everything before it is the
  // header block. If there's no blank line, treat the whole file as header
  // (some server-exported tiddlers with no body).
  const crlfSep = content.indexOf('\r\n\r\n');
  const lfSep = content.indexOf('\n\n');
  const sep = crlfSep !== -1 && (lfSep === -1 || crlfSep < lfSep) ? crlfSep : lfSep;
  const headerBlock = sep === -1 ? content : content.slice(0, sep);

  let title: string | undefined;
  let revision: string | undefined;
  let bag: string | undefined;

  for (const rawLine of headerBlock.split(/\r?\n/)) {
    const colonIndex = rawLine.indexOf(':');
    if (colonIndex <= 0) continue;
    const key = rawLine.slice(0, colonIndex).trim().toLowerCase();
    const value = rawLine.slice(colonIndex + 1).trim();
    if (value.length === 0) continue;
    if (key === 'title') title = value;
    else if (key === 'revision') revision = value;
    else if (key === 'bag') bag = value;
  }

  if (title === undefined || revision === undefined) return undefined;
  return { title, revision, bag };
}

/**
 * Parse a `.json` file (TW's multi-tiddler or single-tiddler JSON format).
 *
 * Accepts either:
 *   - an array of tiddler objects (the normal multi-tiddler export)
 *   - a single tiddler object (some plugin exports)
 *
 * Emits one seed entry per tiddler that has both `title` and `revision`.
 * Revisions are coerced from number → string for server compatibility.
 */
export function parseJsonSeed(content: string): SnapshotSeedEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const entries: SnapshotSeedEntry[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const title = typeof record.title === 'string' ? record.title : undefined;
    const revisionRaw = record.revision;
    const revision = typeof revisionRaw === 'string'
      ? revisionRaw
      : typeof revisionRaw === 'number'
        ? String(revisionRaw)
        : undefined;
    if (title === undefined || title.length === 0) continue;
    if (revision === undefined || revision.length === 0) continue;
    const bag = typeof record.bag === 'string' ? record.bag : undefined;
    entries.push({ title, revision, bag });
  }
  return entries;
}

/**
 * Dispatch by file extension. Returns the list of seed entries this file
 * contributes (0, 1, or many). Unknown extensions or parse failures are
 * silently skipped — seeding is a best-effort optimisation, so missing a few
 * entries just means the first sync pulls them instead.
 */
export function extractSeedEntriesFromFile(fileName: string, content: string): SnapshotSeedEntry[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.tid')) {
    const entry = parseTidSeed(content);
    return entry === undefined ? [] : [entry];
  }
  if (lower.endsWith('.json')) {
    return parseJsonSeed(content);
  }
  return [];
}
