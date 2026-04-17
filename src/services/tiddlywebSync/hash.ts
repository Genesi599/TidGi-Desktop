/**
 * Stable content hash for a tiddler.
 *
 * Used as the "local revision" in the reconciler's three-way merge. Two tiddlers
 * with identical user-visible content must produce identical hashes across runs
 * and across machines, so this function:
 *   - Sorts keys alphabetically before serialising.
 *   - Excludes fields that change on every touch but don't represent content
 *     (`modified`, `created`, `revision`, `bag`).
 *   - Treats `undefined` and missing as the same.
 *   - Treats tags field as a string (that's how TW stores them); callers must
 *     normalise (e.g. tags array → `[[foo]] [[bar]]`) BEFORE calling.
 *
 * Algorithm: SHA-1 over a canonical JSON serialisation. Truncated to 16 hex
 * chars (64 bits) which is ample for collision avoidance within a wiki.
 */

import { createHash } from 'crypto';

/**
 * Fields that are metadata and must not contribute to the content hash.
 *
 * `creator` / `modifier` are excluded because TiddlyWiki's `addTiddler` API
 * auto-populates them with the current user on every write. If we hashed them,
 * writing a server tiddler locally would produce a different hash than the
 * server's (since server's user context differs) — the reconciler would
 * mistake it for "local content changed", leading to spurious push-or-conflict
 * cycles on every subsequent sync. The cost of excluding them is low: both
 * sides still TRANSFER these fields, just don't use them to judge equality.
 */
const METADATA_FIELDS = new Set(['modified', 'created', 'revision', 'bag', 'creator', 'modifier']);

export function computeTiddlerHash(fields: Record<string, string | undefined>): string {
  const keys = Object.keys(fields)
    .filter((k) => !METADATA_FIELDS.has(k))
    .filter((k) => fields[k] !== undefined && fields[k] !== '')
    .sort();
  // Build canonical JSON — we don't use JSON.stringify's default order.
  const canonical = keys.map((k) => [k, fields[k]] as const);
  const serialised = JSON.stringify(canonical);
  return createHash('sha1').update(serialised).digest('hex').slice(0, 16);
}
