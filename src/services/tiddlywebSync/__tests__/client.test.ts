import { describe, expect, test, vi } from 'vitest';

import { TiddlyWebClient, TiddlyWebHttpError } from '../client';

/**
 * These tests pin down the behaviour callers and the reconciler depend on:
 *  - URL encoding for non-ASCII / special-char titles (the bug we fixed in
 *    the past where `encodeURI` was used and `/` etc were left raw).
 *  - The `X-Requested-With: TiddlyWiki` header on every request (TW server
 *    refuses mutating requests without it; another previous footgun).
 *  - Re-injection of `title` in fetchOne when the server omits it (caused the
 *    830-tiddler silent data-loss bug).
 *  - Etag → revision parsing.
 *  - Basic auth header construction.
 */

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function makeFetch(handler: (url: string, init: RequestInit) => Response): {
  fetchImpl: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('TiddlyWebClient', () => {
  test('listAll: GETs /recipes/<recipe>/tiddlers.json with required headers', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse([
        { title: 'Foo', revision: '1' },
        { title: 'Bar', revision: '5', bag: 'b' },
      ]),
    );
    const client = new TiddlyWebClient({
      baseUrl: 'https://wiki.example.com/',
      recipe: 'default',
      fetchImpl,
    });
    const result = await client.listAll();

    expect(result).toEqual([
      { title: 'Foo', revision: '1', bag: undefined, modified: undefined },
      { title: 'Bar', revision: '5', bag: 'b', modified: undefined },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://wiki.example.com/recipes/default/tiddlers.json');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['X-Requested-With']).toBe('TiddlyWiki');
    expect(headers.Accept).toBe('application/json');
  });

  test('listAll: filters out items missing title or revision', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse([
        { title: 'Foo', revision: '1' },
        { title: 'NoRev' }, // dropped
        { revision: '2' }, // dropped
      ]),
    );
    const client = new TiddlyWebClient({ baseUrl: 'https://w', recipe: 'r', fetchImpl });
    const result = await client.listAll();
    expect(result).toEqual([{ title: 'Foo', revision: '1', bag: undefined, modified: undefined }]);
  });

  test('listAll: throws TiddlyWebHttpError on non-2xx', async () => {
    const { fetchImpl } = makeFetch(() => new Response('Forbidden', { status: 403 }));
    const client = new TiddlyWebClient({ baseUrl: 'https://w', recipe: 'r', fetchImpl });
    await expect(client.listAll()).rejects.toBeInstanceOf(TiddlyWebHttpError);
  });

  test('fetchOne: encodes special-char titles via encodeURIComponent', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ text: 'body' }));
    const client = new TiddlyWebClient({ baseUrl: 'https://w', recipe: 'r', fetchImpl });
    await client.fetchOne('$:/foo/bar baz');
    // `$`, `:`, `/`, ` ` must all be percent-encoded
    expect(calls[0].url).toBe('https://w/recipes/r/tiddlers/%24%3A%2Ffoo%2Fbar%20baz');
  });

  test('fetchOne: injects title when server response omits it', async () => {
    // This was the silent data-loss bug: server returns body WITHOUT a title
    // field, callers used `body.title` and got undefined → tiddler dropped.
    const { fetchImpl } = makeFetch(() => jsonResponse({ text: 'body', tags: 'x' }));
    const client = new TiddlyWebClient({ baseUrl: 'https://w', recipe: 'r', fetchImpl });
    const result = await client.fetchOne('MyTitle');
    expect(result.title).toBe('MyTitle');
    expect(result.text).toBe('body');
    expect(result.tags).toBe('x');
  });

  test('fetchOne: server-provided title is preserved', async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ title: 'ServerTitle', text: 'b' }));
    const client = new TiddlyWebClient({ baseUrl: 'https://w', recipe: 'r', fetchImpl });
    const result = await client.fetchOne('UrlTitle');
    expect(result.title).toBe('ServerTitle');
  });

  test('put: PUTs JSON without title/bag/revision in body, parses revision from etag', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      // 204 is a null-body status per spec — body must be null, not ''.
      new Response(null, {
        status: 204,
        headers: { etag: '"default/MyTitle/42:abc"' },
      }),
    );
    const client = new TiddlyWebClient({ baseUrl: 'https://w', recipe: 'r', fetchImpl });
    const result = await client.put({ title: 'MyTitle', text: 'hi', bag: 'default', revision: '41' });

    expect(calls[0].init.method).toBe('PUT');
    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ text: 'hi' });
    expect(body).not.toHaveProperty('title');
    expect(body).not.toHaveProperty('bag');
    expect(body).not.toHaveProperty('revision');

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Requested-With']).toBe('TiddlyWiki');

    expect(result.revision).toBe('42');
  });

  test('put: returns undefined revision when no etag header', async () => {
    const { fetchImpl } = makeFetch(() => new Response(null, { status: 204 }));
    const client = new TiddlyWebClient({ baseUrl: 'https://w', recipe: 'r', fetchImpl });
    const result = await client.put({ title: 'X', text: 'y' });
    expect(result.revision).toBeUndefined();
  });

  test('delete: DELETEs to /bag/<bag>/tiddlers/<title> with bag fallback to recipe', async () => {
    const { fetchImpl, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const client = new TiddlyWebClient({ baseUrl: 'https://w', recipe: 'myRecipe', fetchImpl });
    await client.delete('Foo');
    expect(calls[0].url).toBe('https://w/bag/myRecipe/tiddlers/Foo');
    expect(calls[0].init.method).toBe('DELETE');
  });

  test('delete: 404 is tolerated (already gone)', async () => {
    const { fetchImpl } = makeFetch(() => new Response('Not found', { status: 404 }));
    const client = new TiddlyWebClient({ baseUrl: 'https://w', recipe: 'r', fetchImpl });
    await expect(client.delete('Foo')).resolves.toBeUndefined();
  });

  test('delete: other 4xx/5xx still throws', async () => {
    const { fetchImpl } = makeFetch(() => new Response('Server error', { status: 500 }));
    const client = new TiddlyWebClient({ baseUrl: 'https://w', recipe: 'r', fetchImpl });
    await expect(client.delete('Foo')).rejects.toBeInstanceOf(TiddlyWebHttpError);
  });

  test('basic auth header is added when credentials supplied', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse([]));
    const client = new TiddlyWebClient({
      baseUrl: 'https://w',
      recipe: 'r',
      username: 'alice',
      password: 'secret',
      fetchImpl,
    });
    await client.listAll();
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('alice:secret', 'utf8').toString('base64')}`);
  });

  test('basic auth header omitted when no credentials', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse([]));
    const client = new TiddlyWebClient({ baseUrl: 'https://w', recipe: 'r', fetchImpl });
    await client.listAll();
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  test('checkReachable returns true on 2xx', async () => {
    const { fetchImpl } = makeFetch(() => new Response('{}', { status: 200 }));
    const client = new TiddlyWebClient({ baseUrl: 'https://w', recipe: 'r', fetchImpl });
    expect(await client.checkReachable()).toBe(true);
  });

  test('checkReachable returns false on network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const client = new TiddlyWebClient({ baseUrl: 'https://w', recipe: 'r', fetchImpl });
    expect(await client.checkReachable()).toBe(false);
  });

  test('checkReachable returns false on 401', async () => {
    const { fetchImpl } = makeFetch(() => new Response('', { status: 401 }));
    const client = new TiddlyWebClient({ baseUrl: 'https://w', recipe: 'r', fetchImpl });
    expect(await client.checkReachable()).toBe(false);
  });

  test('trailing slash on baseUrl is stripped', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse([]));
    const client = new TiddlyWebClient({ baseUrl: 'https://w///', recipe: 'r', fetchImpl });
    await client.listAll();
    expect(calls[0].url).toBe('https://w/recipes/r/tiddlers.json');
  });
});
