/**
 * Pixel statistics, fetched by the half of the system that is allowed to.
 *
 * `GET /{pixel}/stats` is the one read in this whole project that a
 * token holding only `ads_read` cannot make: it answers
 * `(#100) Permission Denied` and requires `ads_management`. Verified
 * against a live account, including that it is not a permission on the
 * asset (the system user had ADVERTISE, UPLOAD and ANALYZE on the pixel)
 * and that no other endpoint returns the same numbers.
 *
 * That leaves an awkward choice: either give the internet-facing Worker
 * a token that can spend money, or lose the two checks that read event
 * quality. This module is the third option. The executor Worker already
 * holds the wide token and has no `fetch` handler, so nothing can reach
 * it from outside. It reads these numbers on its own schedule and writes
 * them to the shared database; the agent reads the saved copy and never
 * needs the wider token at all.
 *
 * The cost of the arrangement, stated plainly: these figures are as old
 * as the last executor run. For event match quality, which moves over
 * weeks, that is fine. It would not be fine for anything used to decide
 * whether an event is arriving right now, and nothing here does that.
 */

import type { MetaClient } from "./client.ts";
import type { Config } from "../config.ts";
import type { PixelStat } from "./types.ts";
import type { Snapshot } from "./snapshot.ts";

/** One pixel's saved numbers. */
export type SavedStats = {
  pixelId: string;
  readAt: string;
  events: PixelStat[];
  matching: PixelStat[];
};

/**
 * Flattens what `/stats` returns.
 *
 * The response nests one array inside another: an outer entry per time
 * bucket, each holding the counts for that bucket. Reading only the
 * first bucket, which is the obvious mistake, gives you an hour of data
 * and makes a busy pixel look dead.
 */
function flatten(response: { data?: { data?: PixelStat[] }[] } | null): PixelStat[] {
  const totals = new Map<string, number>();
  for (const bucket of response?.data ?? []) {
    for (const row of bucket.data ?? []) {
      const key = String(row.value ?? "");
      if (!key) continue;
      totals.set(key, (totals.get(key) ?? 0) + Number(row.count ?? 0));
    }
  }
  return [...totals].map(([value, count]) => ({ value, count }));
}

/**
 * Reads and stores the stats for every configured pixel.
 *
 * Called by the executor, with the wide token. Failures are recorded and
 * skipped: yesterday's numbers are better than none, and this must never
 * be the reason the executor fails to apply an approved change.
 */
export async function refreshPixelStats(
  client: MetaClient,
  config: Config,
  db: D1Database,
): Promise<{ updated: string[]; failed: string[] }> {
  const updated: string[] = [];
  const failed: string[] = [];

  for (const brand of config.brands) {
    const [events, matching] = await Promise.all([
      client.get<{ data?: { data?: PixelStat[] }[] }>(`${brand.pixelId}/stats`, {
        aggregation: "event_total_counts",
      }),
      client.get<{ data?: { data?: PixelStat[] }[] }>(`${brand.pixelId}/stats`, {
        aggregation: "had_pii",
      }),
    ]);

    if (!events.ok || !matching.ok) {
      const why = events.ok ? matching : events;
      console.error(`[pixel-stats] ${brand.pixelId}: ${!why.ok ? why.reason : "unknown"}`);
      failed.push(brand.pixelId);
      continue;
    }

    await db
      .prepare(
        `insert into pixel_stats (pixel_id, read_at, events, matching)
         values (?, datetime('now'), ?, ?)
         on conflict(pixel_id) do update set
           read_at = excluded.read_at,
           events = excluded.events,
           matching = excluded.matching`,
      )
      .bind(
        brand.pixelId,
        JSON.stringify(flatten(events.value)),
        JSON.stringify(flatten(matching.value)),
      )
      .run();

    updated.push(brand.pixelId);
  }

  return { updated, failed };
}

/**
 * Fills a snapshot's pixel readings from the saved copy.
 *
 * Anything with no saved row is left empty rather than guessed at, and
 * the checks that read it then have nothing to say. That is the correct
 * behaviour on a fresh install, where the executor has not run yet.
 */
export async function hydratePixelStats(db: D1Database, snapshot: Snapshot): Promise<string[]> {
  const stale: string[] = [];
  const ids = Object.keys(snapshot.pixels);
  if (ids.length === 0) return stale;

  const rows = await db
    .prepare(
      `select pixel_id, read_at, events, matching from pixel_stats
       where pixel_id in (${ids.map(() => "?").join(", ")})`,
    )
    .bind(...ids)
    .all<{ pixel_id: string; read_at: string; events: string; matching: string }>();

  const saved = new Map((rows.results ?? []).map((row) => [row.pixel_id, row]));

  for (const id of ids) {
    const row = saved.get(id);
    const reading = snapshot.pixels[id];
    if (!reading) continue;
    if (!row) {
      stale.push(id);
      continue;
    }
    try {
      reading.events = JSON.parse(row.events) as PixelStat[];
      reading.matching = JSON.parse(row.matching) as PixelStat[];
    } catch {
      stale.push(id);
    }
  }

  return stale;
}
