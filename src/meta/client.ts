/**
 * Read only client for Meta's Marketing API.
 *
 * Every function here issues a GET. There is no POST in this file and
 * there is no POST anywhere else in this Worker, which is the whole
 * point: the access token Meta hands out for ads management can spend
 * money, and Meta's own console will not let you take that permission
 * away once a token has it. So the boundary is drawn in the code and
 * enforced by a lint rule, not by trusting the token.
 *
 * Writing happens in the executor Worker, which has no `fetch` handler
 * and therefore no address on the internet. See the README.
 *
 * Nothing here throws. This runs inside a scheduled task that does other
 * work too, and an API that is having a bad morning should cost you the
 * analysis, not the whole run.
 */

const GRAPH = "https://graph.facebook.com/v21.0";

/** How many times a rate limited call is retried before giving up. */
const RETRIES = 3;

export type Credentials = {
  /** A token with `ads_read`. It does not need anything else. */
  token: string;
  /** With the `act_` prefix. Meta's UI shows it without and rejects it that way. */
  accountId: string;
};

export type Failure = { ok: false; reason: string };
export type Success<T> = { ok: true; value: T; calls: number };
export type Result<T> = Success<T> | Failure;

/**
 * Meta's rate limit is per ad account and it is not a permission
 * problem: it clears itself in a few minutes. Telling the two apart
 * matters, because one is worth waiting for and the other never is.
 */
function isRateLimit(status: number, body: string): boolean {
  if (status === 429 || status >= 500) return true;
  return body.includes("(#17)") || body.toLowerCase().includes("too many api calls");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Values that are objects travel as JSON inside the query string. This
 * catches everyone once: `time_range` and `effective_status` are not
 * scalars and Meta wants them serialised, not form encoded.
 */
function toQuery(params: Record<string, unknown>): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    query.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return query;
}

export class MetaClient {
  /** Kept private so it cannot end up in a log line or an error message. */
  #token: string;
  /** Every call made since this client was built, for the run's budget. */
  calls = 0;

  readonly account: string;

  // Written out rather than declared as a constructor parameter
  // property: that shorthand is TypeScript-only syntax that has to be
  // compiled away, and it will not run under Node's type stripping,
  // which is what `tools/dry-run.ts` uses.
  constructor(credentials: Credentials) {
    this.#token = credentials.token;
    this.account = credentials.accountId;
  }

  async #fetch<T>(url: string): Promise<Result<T>> {
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      this.calls++;
      let response: Response;
      try {
        response = await fetch(url, { headers: { Accept: "application/json" } });
      } catch (err) {
        return { ok: false, reason: `network: ${String(err)}` };
      }

      if (response.ok) {
        return { ok: true, value: (await response.json()) as T, calls: this.calls };
      }

      // The body says what actually went wrong: a wrong field name, a
      // missing permission, a deprecated parameter. Losing it means
      // debugging blind. The token is never in the body.
      const body = await response.text();
      if (isRateLimit(response.status, body) && attempt < RETRIES) {
        await wait(30_000 * (attempt + 1));
        continue;
      }
      return { ok: false, reason: `http ${response.status}: ${body.slice(0, 400)}` };
    }
    return { ok: false, reason: "gave up after retries" };
  }

  /** A single node or edge, without following pagination. */
  async get<T>(path: string, params: Record<string, unknown> = {}): Promise<Result<T>> {
    const query = toQuery(params);
    query.set("access_token", this.#token);
    return this.#fetch<T>(`${GRAPH}/${path}?${query}`);
  }

  /**
   * An edge, following pagination to the end.
   *
   * `maxPages` exists because a run that quietly walks forty pages is
   * how an account ends up rate limited for everything else, including
   * reading back what you just changed. Hitting the cap is reported, not
   * swallowed: a truncated list looks exactly like a short one.
   */
  async list<T>(
    path: string,
    params: Record<string, unknown> = {},
    maxPages = 10,
  ): Promise<Result<T[]>> {
    const query = toQuery(params);
    query.set("access_token", this.#token);

    let url: string | undefined = `${GRAPH}/${path}?${query}`;
    const rows: T[] = [];

    for (let page = 0; page < maxPages && url; page++) {
      const result: Result<{ data?: T[]; paging?: { next?: string } }> =
        await this.#fetch(url);
      if (!result.ok) return result;
      rows.push(...(result.value.data ?? []));
      url = result.value.paging?.next;
    }

    if (url) {
      return { ok: false, reason: `more than ${maxPages} pages at ${path}` };
    }
    return { ok: true, value: rows, calls: this.calls };
  }
}
