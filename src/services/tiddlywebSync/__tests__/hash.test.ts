import { describe, expect, test } from 'vitest';

import { computeTiddlerHash } from '../hash';

describe('computeTiddlerHash', () => {
  test('identical content produces identical hash', () => {
    const a = computeTiddlerHash({ title: 'Foo', text: 'hello', tags: 'a b' });
    const b = computeTiddlerHash({ title: 'Foo', text: 'hello', tags: 'a b' });
    expect(a).toBe(b);
  });

  test('different text produces different hash', () => {
    const a = computeTiddlerHash({ title: 'Foo', text: 'hello' });
    const b = computeTiddlerHash({ title: 'Foo', text: 'world' });
    expect(a).not.toBe(b);
  });

  test('different title produces different hash', () => {
    const a = computeTiddlerHash({ title: 'A', text: 'x' });
    const b = computeTiddlerHash({ title: 'B', text: 'x' });
    expect(a).not.toBe(b);
  });

  test('field key order does not matter', () => {
    const a = computeTiddlerHash({ title: 'Foo', text: 'hi', tags: 'a' });
    const b = computeTiddlerHash({ tags: 'a', text: 'hi', title: 'Foo' });
    expect(a).toBe(b);
  });

  test('metadata fields are excluded', () => {
    // Same content, different metadata → same hash. This is what makes the
    // reconciler's "did the user actually change something" check work.
    const a = computeTiddlerHash({
      title: 'Foo',
      text: 'hi',
      modified: '20240101000000000',
      created: '20230101000000000',
      revision: '5',
      bag: 'default',
    });
    const b = computeTiddlerHash({
      title: 'Foo',
      text: 'hi',
      modified: '20250515000000000',
      created: '20240601000000000',
      revision: '99',
      bag: 'other',
    });
    expect(a).toBe(b);
  });

  test('undefined and missing fields are equivalent', () => {
    const a = computeTiddlerHash({ title: 'Foo', text: 'hi', tags: undefined });
    const b = computeTiddlerHash({ title: 'Foo', text: 'hi' });
    expect(a).toBe(b);
  });

  test('empty string and missing fields are equivalent', () => {
    // Server may return `tags: ''` while local has the field absent; we don't
    // want that to look like a real change.
    const a = computeTiddlerHash({ title: 'Foo', text: 'hi', tags: '' });
    const b = computeTiddlerHash({ title: 'Foo', text: 'hi' });
    expect(a).toBe(b);
  });

  test('user fields contribute to hash', () => {
    const a = computeTiddlerHash({ title: 'Foo', text: 'x', 'my-custom': 'v1' });
    const b = computeTiddlerHash({ title: 'Foo', text: 'x', 'my-custom': 'v2' });
    expect(a).not.toBe(b);
  });

  test('hash is 16 hex chars', () => {
    const h = computeTiddlerHash({ title: 'Foo', text: 'hi' });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});
