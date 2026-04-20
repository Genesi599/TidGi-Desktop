import path from 'path';
import { pathExists, readdir, remove } from 'fs-extra';

/**
 * Files inside `tiddlers/system/` that survive {@link selectiveWipeTiddlersFolder}
 * during a TiddlyWeb clone. Everything else gets wiped.
 *
 * The whitelist is intentionally tiny: **only a fallback vanilla theme**, so
 * that if the remote server turns out not to provide any theme via its HTML
 * snapshot (common on externalised-storage servers whose root HTML doesn't
 * inline plugin shadows), the cloned wiki still renders with a real sidebar
 * and styled tiddlers instead of raw unstyled HTML.
 *
 * TidGi's template ships ~60 other plugin bundles in `system/`
 * (`$__plugins_linonetwo_*`, `$__plugins_Gk0Wk_*`, etc.). Those are NOT on
 * this list — if we preserved them, a cloned TiddlyWeb workspace would end
 * up running with TidGi's curated plugin set rather than the **server's**
 * plugins, which defeats the point of cloning a specific wiki. When the
 * HTML snapshot extraction imports plugins, they land in `system/` with
 * `overwrite: true`; leaving TidGi's template plugins in place would mean
 * the two sets compete instead of the server's winning cleanly.
 *
 * The `.meta` file is kept alongside its JSON because TW reads
 * `<filename>.meta` to recover fields (revision, bag, etc.) that don't fit
 * inside plain JSON. Without it, the theme may still load but revision
 * tracking is off.
 */
export const PRESERVED_FILES_IN_SYSTEM: readonly string[] = [
  '$__themes_tiddlywiki_vanilla.json',
  '$__themes_tiddlywiki_vanilla.json.meta',
];

/**
 * Core filesystem logic for the TiddlyWeb clone flow's selective-wipe step.
 *
 * Wipes essentially everything under `tiddlersDir`, leaving only the small
 * whitelist of files inside `tiddlers/system/` defined by
 * {@link PRESERVED_FILES_IN_SYSTEM} (currently just the vanilla theme
 * fallback). Concretely:
 *
 *   - Every loose file at the top of `tiddlers/` (`Index.tid`, branded
 *     icons, `TheBrain.tid`, `favicon.ico`, ...) is removed — TidGi's
 *     welcome-page content must not get pushed to the user's real server
 *     on first sync. Those titles have no `$:/` prefix, so the reconciler's
 *     default exclude filter `[prefix[$:/]]` would NOT skip them.
 *   - Every non-`system/` subdirectory is removed.
 *   - Inside `system/`, anything not on the whitelist is removed — including
 *     TidGi's template plugin bundles and non-vanilla themes. Plugins /
 *     themes / languages the USER actually wants arrive later via HTML
 *     snapshot extraction (`importTiddlersFromHtmlUrl`) and/or TiddlyWeb
 *     sync from their real server.
 *   - The vanilla theme bundle stays as a safety net so the wiki always
 *     boots with a usable UI, even if the server provides no theme (which
 *     is what the user saw on first-iteration clones: sidebar stuck at the
 *     top of the page, no styles, raw HTML layout).
 *
 * Assumes `tiddlersDir` already exists; callers should `pathExists`-guard
 * before calling.
 *
 * Returns per-bucket counts so callers can log what happened. `removed`
 * counts every filesystem entry removed, including individual files inside
 * `system/`; `preserved` counts only whitelisted files that actually
 * survived (missing whitelist entries are silently tolerated).
 */
export async function selectiveWipeTiddlersFolder(
  tiddlersDir: string,
): Promise<{ removed: number; preserved: number }> {
  const preservedFilesInSystem = new Set(PRESERVED_FILES_IN_SYSTEM);
  let removed = 0;
  let preserved = 0;

  const topEntries = await readdir(tiddlersDir);
  for (const entry of topEntries) {
    const fullPath = path.join(tiddlersDir, entry);
    if (entry !== 'system') {
      await remove(fullPath);
      removed += 1;
      continue;
    }
    // We only recurse one level into `system/`. The whitelist is a flat
    // list of filenames — deeper subfolders (if any ever appear) just get
    // wiped as a conservative default.
    const systemEntries = await readdir(fullPath);
    for (const sysEntry of systemEntries) {
      const sysPath = path.join(fullPath, sysEntry);
      if (preservedFilesInSystem.has(sysEntry)) {
        preserved += 1;
      } else {
        await remove(sysPath);
        removed += 1;
      }
    }
  }

  // If system/ itself doesn't exist (rare — a hand-assembled wiki), there's
  // nothing else to do. We don't materialise an empty system/ just to match
  // the expected shape; the template's own system/ folder is what seeds
  // the whitelist and its absence is the caller's problem to handle.
  if (!(await pathExists(path.join(tiddlersDir, 'system')))) {
    return { removed, preserved };
  }

  return { removed, preserved };
}
