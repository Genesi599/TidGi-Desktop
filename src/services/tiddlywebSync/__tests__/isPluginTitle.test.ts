import { describe, expect, test } from 'vitest';

import { isPluginTitle } from '../index';

describe('isPluginTitle', () => {
  test('matches plugin root titles', () => {
    expect(isPluginTitle('$:/plugins/tiddlywiki/markdown')).toBe(true);
  });

  test('matches plugin shadow/override titles', () => {
    // Users often override individual shadow tiddlers inside a plugin by
    // creating a same-title local tiddler. Those still need a worker restart
    // so the override slots in correctly during plugin re-extraction.
    expect(isPluginTitle('$:/plugins/tiddlywiki/markdown/macros/foo')).toBe(true);
  });

  test('matches theme titles', () => {
    expect(isPluginTitle('$:/themes/tiddlywiki/vanilla')).toBe(true);
  });

  test('matches language titles', () => {
    expect(isPluginTitle('$:/languages/zh-Hans')).toBe(true);
  });

  test('matches plugin-disabled config titles', () => {
    // `$:/config/Plugins/Disabled/<name>` only takes effect at boot, so
    // flipping it via sync still requires a restart.
    expect(isPluginTitle('$:/config/Plugins/Disabled/$:/plugins/foo/bar')).toBe(true);
  });

  test('does not match regular system tiddlers', () => {
    expect(isPluginTitle('$:/StoryList')).toBe(false);
    expect(isPluginTitle('$:/DefaultTiddlers')).toBe(false);
    expect(isPluginTitle('$:/core')).toBe(false); // core is bundled, not synced
  });

  test('does not match user tiddlers', () => {
    expect(isPluginTitle('HelloThere')).toBe(false);
    expect(isPluginTitle('额叶')).toBe(false);
  });

  test('does not match other $:/config/ namespaces', () => {
    // Only the Plugins/Disabled sub-namespace triggers a restart — the
    // general $:/config/ namespace is runtime-reactive.
    expect(isPluginTitle('$:/config/AnimationDuration')).toBe(false);
    expect(isPluginTitle('$:/config/PageControlButtons/Visibility/$:/core/ui/Buttons/save')).toBe(false);
  });

  test('empty string is not a plugin title', () => {
    expect(isPluginTitle('')).toBe(false);
  });
});
