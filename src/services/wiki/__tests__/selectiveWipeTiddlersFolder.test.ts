import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdir, pathExists, readdir, remove, writeFile } from 'fs-extra';

// Import from the dedicated module (not `../index.ts`) so the test doesn't
// drag in the Wiki service's DI graph and `?nodeWorker` Vite import, which
// would fail to resolve under vitest.
import { selectiveWipeTiddlersFolder, PRESERVED_FILES_IN_SYSTEM } from '../selectiveWipeTiddlersFolder';

/**
 * These tests guard the TiddlyWeb clone flow's selective-wipe policy:
 *
 *   - TidGi's top-level user-visible tiddlers (`Index.tid`, branded icons,
 *     etc.) MUST be wiped — otherwise they get pushed to the real server on
 *     first sync, polluting it with TidGi's welcome page.
 *   - TidGi's template plugins under `system/` MUST be wiped — otherwise
 *     the cloned wiki shows TidGi's curated plugin set instead of the
 *     SERVER's plugins, which defeats the point of cloning that specific
 *     wiki. (The server's plugins arrive later via HTML snapshot extraction
 *     and/or TiddlyWeb sync.)
 *   - A minimal theme fallback (`$__themes_tiddlywiki_vanilla.json`) MUST
 *     be preserved — so that if the server provides no theme (e.g., an
 *     externalised-storage server whose root HTML doesn't inline plugin
 *     shadows), the cloned wiki still renders with styled sidebar and
 *     tiled tiddlers instead of raw unstyled HTML.
 *
 * Regressions here mean either (a) the clone pollutes the remote server,
 * (b) the cloned wiki boots themeless, or (c) the user sees TidGi's
 * plugins instead of their own server's plugins.
 */
describe('selectiveWipeTiddlersFolder', () => {
  let tempRoot: string;
  let tiddlersDir: string;
  let systemDir: string;

  beforeEach(async () => {
    tempRoot = path.join(os.tmpdir(), `tidgi-wipe-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    tiddlersDir = path.join(tempRoot, 'tiddlers');
    systemDir = path.join(tiddlersDir, 'system');
    await mkdir(systemDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await remove(tempRoot);
    } catch {
      // best effort
    }
  });

  test('removes top-level user-visible files', async () => {
    await writeFile(path.join(tiddlersDir, 'Index.tid'), 'title: Index\n\ncontent');
    await writeFile(path.join(tiddlersDir, 'TheBrain.tid'), 'title: TheBrain');
    await writeFile(path.join(tiddlersDir, 'favicon.ico'), Buffer.from([0, 1, 2, 3]));

    const result = await selectiveWipeTiddlersFolder(tiddlersDir);

    expect(result.removed).toBe(3);
    expect(result.preserved).toBe(0);
    const remaining = await readdir(tiddlersDir);
    // system/ is preserved as a directory even if it was empty to start with
    expect(remaining).toEqual(['system']);
  });

  test('wipes TidGi template plugins but keeps vanilla theme fallback', async () => {
    // Simulate a realistic template system/ layout: ~60 plugin bundles plus
    // the vanilla theme we want to keep as a fallback.
    await writeFile(path.join(systemDir, '$__themes_tiddlywiki_vanilla.json'), '{"title":"$:/themes/tiddlywiki/vanilla"}');
    await writeFile(path.join(systemDir, '$__themes_tiddlywiki_vanilla.json.meta'), 'revision: 1');
    await writeFile(path.join(systemDir, '$__plugins_linonetwo_autocomplete.json'), '{"title":"$:/plugins/linonetwo/autocomplete"}');
    await writeFile(path.join(systemDir, '$__plugins_Gk0Wk_echarts.json'), '{"title":"$:/plugins/Gk0Wk/echarts"}');
    await writeFile(path.join(systemDir, '$__languages_zh-Hans.json'), '{"title":"$:/languages/zh-Hans"}');
    await writeFile(path.join(systemDir, '$__DefaultTiddlers.tid'), 'title: $:/DefaultTiddlers');

    const result = await selectiveWipeTiddlersFolder(tiddlersDir);

    // 4 wiped inside system/: 2 plugins + 1 language + 1 DefaultTiddlers.tid
    expect(result.removed).toBe(4);
    // 2 preserved: vanilla theme JSON + its .meta sidecar
    expect(result.preserved).toBe(2);

    const systemFiles = (await readdir(systemDir)).sort();
    expect(systemFiles).toEqual([
      '$__themes_tiddlywiki_vanilla.json',
      '$__themes_tiddlywiki_vanilla.json.meta',
    ]);
  });

  test('leaves vanilla theme meta preserved even when the JSON is missing', async () => {
    // Belt-and-braces: whitelist lookup is per-filename, so a caller that
    // only shipped the .meta sidecar (an unusual layout, but not unheard of)
    // still gets its meta kept.
    await writeFile(path.join(systemDir, '$__themes_tiddlywiki_vanilla.json.meta'), 'revision: 1');
    await writeFile(path.join(systemDir, '$__plugins_foo.json'), '{}');

    const result = await selectiveWipeTiddlersFolder(tiddlersDir);
    expect(result.removed).toBe(1);
    expect(result.preserved).toBe(1);
    expect(await pathExists(path.join(systemDir, '$__themes_tiddlywiki_vanilla.json.meta'))).toBe(true);
    expect(await pathExists(path.join(systemDir, '$__plugins_foo.json'))).toBe(false);
  });

  test('is a no-op when directory only has an empty system/', async () => {
    const result = await selectiveWipeTiddlersFolder(tiddlersDir);
    expect(result.removed).toBe(0);
    expect(result.preserved).toBe(0);
  });

  test('wipes non-system subdirectories entirely', async () => {
    // Safety rail: if a template adds a new subfolder in the future, it
    // shouldn't silently escape the clean-clone policy. Only the literal
    // `system/` is treated specially.
    const unknownSubdir = path.join(tiddlersDir, 'random-user-folder');
    await mkdir(unknownSubdir, { recursive: true });
    await writeFile(path.join(unknownSubdir, 'whatever.tid'), 'title: whatever');

    const result = await selectiveWipeTiddlersFolder(tiddlersDir);

    expect(result.removed).toBe(1);
    expect(result.preserved).toBe(0);
    expect(await pathExists(unknownSubdir)).toBe(false);
    expect(await pathExists(systemDir)).toBe(true);
  });

  test('tolerates a missing system/ subfolder', async () => {
    // A wiki that was hand-assembled without system/ shouldn't blow up the wipe.
    await remove(systemDir);
    await writeFile(path.join(tiddlersDir, 'Index.tid'), 'title: Index');

    const result = await selectiveWipeTiddlersFolder(tiddlersDir);
    expect(result.removed).toBe(1);
    expect(result.preserved).toBe(0);
  });

  test('PRESERVED_FILES_IN_SYSTEM keeps vanilla theme on the whitelist', () => {
    // Belt-and-braces: catches accidental rename / removal. Changing this
    // whitelist is a policy decision and should be deliberate, not a silent
    // commit. Also guards against losing the .meta sidecar entry.
    expect(PRESERVED_FILES_IN_SYSTEM).toContain('$__themes_tiddlywiki_vanilla.json');
    expect(PRESERVED_FILES_IN_SYSTEM).toContain('$__themes_tiddlywiki_vanilla.json.meta');
  });

  test('does not preserve any plugin bundle by default', () => {
    // Rephrasing of the same policy in negative form: the point of this
    // change is that TidGi's template plugins must NOT be on the preserve
    // list. The server's plugins come in via HTML snapshot extraction.
    const hasAnyPlugin = PRESERVED_FILES_IN_SYSTEM.some((name) => name.startsWith('$__plugins_'));
    expect(hasAnyPlugin).toBe(false);
  });
});
