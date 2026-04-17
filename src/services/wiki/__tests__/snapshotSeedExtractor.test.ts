import { describe, expect, test } from 'vitest';

import {
  extractSeedEntriesFromFile,
  parseJsonSeed,
  parseTidSeed,
} from '../snapshotSeedExtractor';

describe('parseTidSeed', () => {
  test('extracts title + revision + bag from a standard .tid file', () => {
    const content = [
      'title: Foo',
      'revision: 42',
      'bag: default',
      'type: text/vnd.tiddlywiki',
      '',
      'Hello world.',
    ].join('\n');
    expect(parseTidSeed(content)).toEqual({
      title: 'Foo',
      revision: '42',
      bag: 'default',
    });
  });

  test('handles CRLF line endings (TW writes LF on POSIX but .tid files may travel through Windows)', () => {
    const content = 'title: Bar\r\nrevision: 7\r\n\r\nbody';
    expect(parseTidSeed(content)).toEqual({ title: 'Bar', revision: '7' });
  });

  test('returns undefined when revision is missing (never synced from a server)', () => {
    const content = 'title: Local Only\ntype: text/plain\n\nbody';
    expect(parseTidSeed(content)).toBeUndefined();
  });

  test('returns undefined when title is missing', () => {
    const content = 'revision: 3\ntype: text/plain\n\nbody';
    expect(parseTidSeed(content)).toBeUndefined();
  });

  test('handles a tiddler with no body (no blank line separator)', () => {
    const content = 'title: Headline\nrevision: 1';
    expect(parseTidSeed(content)).toEqual({ title: 'Headline', revision: '1' });
  });

  test('ignores fields with blank values and case-folds field names', () => {
    const content = 'Title: Baz\nRevision: 99\ntags:\n\nbody';
    expect(parseTidSeed(content)).toEqual({ title: 'Baz', revision: '99' });
  });

  test('treats everything before the first blank line as header (body may contain colons)', () => {
    const content = 'title: X\nrevision: 2\n\nthis: looks like a field but is body';
    expect(parseTidSeed(content)).toEqual({ title: 'X', revision: '2' });
  });
});

describe('parseJsonSeed', () => {
  test('extracts multiple entries from a JSON array', () => {
    const content = JSON.stringify([
      { title: 'A', revision: '1', bag: 'b1', text: 'ignored' },
      { title: 'B', revision: '2', text: 'also ignored' },
      { title: 'C' /* no revision */ },
    ]);
    expect(parseJsonSeed(content)).toEqual([
      { title: 'A', revision: '1', bag: 'b1' },
      { title: 'B', revision: '2' },
    ]);
  });

  test('accepts a single tiddler object (some plugin exports)', () => {
    const content = JSON.stringify({ title: '$:/plugins/foo', revision: '101' });
    expect(parseJsonSeed(content)).toEqual([{ title: '$:/plugins/foo', revision: '101' }]);
  });

  test('coerces numeric revisions to strings', () => {
    const content = JSON.stringify([{ title: 'N', revision: 7 }]);
    expect(parseJsonSeed(content)).toEqual([{ title: 'N', revision: '7' }]);
  });

  test('returns empty array on malformed JSON', () => {
    expect(parseJsonSeed('{not valid}')).toEqual([]);
  });

  test('skips entries missing title or revision', () => {
    const content = JSON.stringify([
      { revision: '1' },
      { title: 'X' },
      { title: '', revision: '1' },
      { title: 'Y', revision: '' },
      { title: 'Z', revision: '1' },
    ]);
    expect(parseJsonSeed(content)).toEqual([{ title: 'Z', revision: '1' }]);
  });
});

describe('extractSeedEntriesFromFile', () => {
  test('dispatches .tid files to parseTidSeed', () => {
    const result = extractSeedEntriesFromFile(
      'Foo.tid',
      'title: Foo\nrevision: 1\n\nbody',
    );
    expect(result).toEqual([{ title: 'Foo', revision: '1' }]);
  });

  test('dispatches .json files to parseJsonSeed', () => {
    const result = extractSeedEntriesFromFile(
      'store.json',
      JSON.stringify([{ title: 'A', revision: '1' }]),
    );
    expect(result).toEqual([{ title: 'A', revision: '1' }]);
  });

  test('returns empty for unknown extensions', () => {
    expect(extractSeedEntriesFromFile('binary.bin', 'random content')).toEqual([]);
  });

  test('is case-insensitive on extension', () => {
    const result = extractSeedEntriesFromFile(
      'Foo.TID',
      'title: Foo\nrevision: 1',
    );
    expect(result).toEqual([{ title: 'Foo', revision: '1' }]);
  });
});
