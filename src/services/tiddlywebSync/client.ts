/**
 * HTTP client for TiddlyWiki's TiddlyWeb-compatible REST API.
 *
 * TiddlyWiki NodeJS server exposes:
 *   GET    /recipes/{recipe}/tiddlers.json       -> list of tiddler summaries (no text field)
 *   GET    /recipes/{recipe}/tiddlers/{title}    -> full tiddler JSON (fields + text)
 *   PUT    /recipes/{recipe}/tiddlers/{title}    -> create / update (body = tiddler JSON)
 *   DELETE /bag/{bag}/tiddlers/{title}           -> delete
 *
 * Notes:
 * - Tiddler titles contain arbitrary Unicode (including `/`, `:`, `$`).
 *   Must use encodeURIComponent, NOT encodeURI.
 * - List endpoint returns summaries WITHOUT the `text` field (lazy). Also, when a tiddler
 *   is fetched individually, the server often omits `title` in the JSON body (it's in the URL).
 *   We re-inject it so callers don't have to think about it. See normaliseTiddler().
 * - TW server requires the non-standard header `X-Requested-With: TiddlyWiki` to accept PUT/DELETE.
 *   Without it you get 403. This was a footgun the user hit in earlier TWSync work.
 */

export interface TiddlerFields {
  title: string;
  text?: string;
  tags?: string;
  type?: string;
  modified?: string;
  created?: string;
  /** Server-managed monotonic id. Only present on GET responses. */
  revision?: string;
  /** Server-managed bag. Needed to construct DELETE URLs. */
  bag?: string;
  /** Anything else. */
  [field: string]: string | undefined;
}

export interface TiddlerSummary {
  title: string;
  revision: string;
  bag?: string;
  modified?: string;
}

export interface TiddlyWebClientConfig {
  /** Base URL, no trailing slash, e.g. `https://wiki.example.com`. */
  baseUrl: string;
  /** Recipe name, default `default`. */
  recipe: string;
  /** Basic-auth username. Empty string = unauthenticated. */
  username?: string;
  /** Basic-auth password. */
  password?: string;
  /** Custom fetch impl (for tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export class TiddlyWebHttpError extends Error {
  constructor(public readonly status: number, public readonly url: string, public readonly body: string) {
    super(`${status} on ${url}: ${body.slice(0, 200)}`);
    this.name = 'TiddlyWebHttpError';
  }
}

export class TiddlyWebClient {
  private readonly baseUrl: string;
  private readonly recipe: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: TiddlyWebClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.recipe = config.recipe || 'default';
    this.fetchImpl = config.fetchImpl ?? (globalThis.fetch as typeof fetch);
    const headers: Record<string, string> = {
      // Required by TiddlyWiki server for mutating requests
      'X-Requested-With': 'TiddlyWiki',
      Accept: 'application/json',
    };
    if (config.username || config.password) {
      const userPass = `${config.username ?? ''}:${config.password ?? ''}`;
      const b64 = typeof Buffer === 'undefined'
        ? globalThis.btoa(userPass)
        : Buffer.from(userPass, 'utf8').toString('base64');
      headers.Authorization = `Basic ${b64}`;
    }
    this.headers = headers;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private recipePath(subPath = ''): string {
    return `/recipes/${encodeURIComponent(this.recipe)}/tiddlers${subPath}`;
  }

  /**
   * List all non-system tiddlers. Returns summaries only (no `text`).
   * Note: server filters are controlled by recipe config; TidGi does its own
   * exclusion filter on top of this using TiddlyWiki filter expressions.
   */
  public async listAll(): Promise<TiddlerSummary[]> {
    const url = this.url(this.recipePath('.json'));
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: this.headers,
      signal: this.config.signal,
    });
    if (!response.ok) {
      throw new TiddlyWebHttpError(response.status, url, await response.text());
    }
    const data = (await response.json()) as Array<{
      title?: unknown;
      revision?: unknown;
      bag?: unknown;
      modified?: unknown;
    }>;
    if (!Array.isArray(data)) {
      throw new Error(`listAll: expected array, got ${typeof data}`);
    }
    // TW server sends revision as a NUMBER for tiddlers loaded from disk (where
    // .tid files don't carry a server revision yet — it defaults to 0) and as
    // a STRING for tiddlers that have been edited through the HTTP API. Accept
    // both and normalise to string downstream.
    const result: TiddlerSummary[] = [];
    for (const t of data) {
      if (typeof t.title !== 'string') continue;
      if (t.revision === undefined || t.revision === null) continue;
      if (typeof t.revision !== 'string' && typeof t.revision !== 'number') continue;
      result.push({
        title: t.title,
        revision: String(t.revision),
        bag: typeof t.bag === 'string' ? t.bag : undefined,
        modified: typeof t.modified === 'string' ? t.modified : undefined,
      });
    }
    return result;
  }

  /**
   * Fetch a single tiddler by title, including text and all fields.
   *
   * Server quirk: the response JSON sometimes omits the `title` field (it's redundant
   * with the URL path). We inject `knownTitle` so callers get a normalised object.
   * This was the root cause of the earlier "830 missing tiddlers" silent data loss bug.
   */
  public async fetchOne(title: string): Promise<TiddlerFields> {
    const url = this.url(`${this.recipePath('/')}${encodeURIComponent(title)}`);
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: this.headers,
      signal: this.config.signal,
    });
    if (!response.ok) {
      throw new TiddlyWebHttpError(response.status, url, await response.text());
    }
    const raw = (await response.json()) as Partial<TiddlerFields>;
    return { ...raw, title: raw.title ?? title } as TiddlerFields;
  }

  /**
   * Create or update a tiddler. Returns the new revision from the `Etag` header.
   * Body is a plain JSON object of fields; `title` is in the URL, not the body.
   */
  public async put(tiddler: TiddlerFields): Promise<{ revision: string | undefined }> {
    const { title, bag: _bag, revision: _revision, ...rest } = tiddler;
    const url = this.url(`${this.recipePath('/')}${encodeURIComponent(title)}`);
    const response = await this.fetchImpl(url, {
      method: 'PUT',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(rest),
      signal: this.config.signal,
    });
    if (!response.ok) {
      throw new TiddlyWebHttpError(response.status, url, await response.text());
    }
    // TW server returns Etag: "bag/title/revision"
    const etag = response.headers.get('etag') ?? response.headers.get('Etag') ?? '';
    const match = /\/(\d+):?/.exec(etag) ?? /"[^"]*\/(\d+)"/.exec(etag);
    return { revision: match?.[1] };
  }

  /**
   * Delete a tiddler. Bag defaults to the recipe name if omitted, which works
   * for the common single-bag setup. For multi-bag recipes callers should pass bag.
   */
  public async delete(title: string, bag?: string): Promise<void> {
    const bagName = bag ?? this.recipe;
    const url = this.url(`/bag/${encodeURIComponent(bagName)}/tiddlers/${encodeURIComponent(title)}`);
    const response = await this.fetchImpl(url, {
      method: 'DELETE',
      headers: this.headers,
      signal: this.config.signal,
    });
    if (!response.ok && response.status !== 404) {
      throw new TiddlyWebHttpError(response.status, url, await response.text());
    }
  }

  /**
   * Lightweight health check: GET /status. Returns true if the server is reachable
   * and auth (if configured) is accepted.
   */
  public async checkReachable(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(this.url('/status'), {
        method: 'GET',
        headers: this.headers,
        signal: this.config.signal,
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
