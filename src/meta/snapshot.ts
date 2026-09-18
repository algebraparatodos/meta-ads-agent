/**
 * One picture of the account per day, stored whole.
 *
 * Collecting and analysing are separate on purpose. Walking an account
 * object by object once left this account answering `(#17) User request
 * limit reached` to everything, including a bare `id,name` read of an ad
 * that had just been created. The lesson written down at the time was to
 * keep on disk everything you fetch, and that is what this does: fifteen
 * calls once a day, saved, and every check and the analyst read the
 * saved copy.
 *
 * It asks at account level rather than object by object. One insights
 * call with `level=ad` returns every ad; asking per ad is nine hundred
 * calls for the same rows, and that is exactly what exhausted the quota.
 */

import type { MetaClient, Result } from "./client.ts";
import type { Config } from "../config.ts";
import { addDays, windowOf } from "../dates.ts";
import type {
  AccountStatus, Ad, AdImage, AdSet, Campaign, CustomAudience, CustomConversion,
  Insight, Pixel, PixelStat,
} from "./types.ts";

export type { PixelStat };

const INSIGHT_FIELDS = [
  "campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name",
  "objective", "impressions", "reach", "frequency", "spend", "cpm", "cpc",
  "ctr", "inline_link_clicks", "actions", "action_values", "cost_per_action_type",
].join(",");

const ADSET_FIELDS = [
  "id", "name", "campaign_id", "effective_status", "status", "daily_budget",
  "lifetime_budget", "optimization_goal", "billing_event", "bid_strategy",
  "destination_type", "start_time", "end_time", "promoted_object",
  "attribution_spec", "targeting",
].join(",");

/**
 * The creative is expanded inline here rather than fetched per ad, which
 * would be hundreds of extra calls. The page size drops to 25 because it
 * is the large pages carrying creatives that trip "Ad Account Has Too
 * Many API Calls", not the number of pages.
 */
const AD_FIELDS =
  "id,name,adset_id,campaign_id,effective_status,status,updated_time," +
  "conversion_domain,tracking_specs," +
  "creative{id,name,title,body,object_type,image_hash,object_story_spec," +
  "asset_feed_spec,url_tags}";

export type PixelReading = {
  node: Pixel | null;
  events: PixelStat[];
  matching: PixelStat[];
};

export type Snapshot = {
  day: string;
  accountId: string;
  currency: string;
  timeZone: string;
  account: AccountStatus | null;
  /** Ad level, the last closed week. Ad level matters: a campaign that
   *  "does not sell" is often one ad that does not sell taking the
   *  budget from three that do, and that is invisible above this. */
  adsRecent: Insight[];
  /** The same week before, so direction can be read instead of guessed. */
  adsPrevious: Insight[];
  /** Ad set level, because the ad set is the thing that has an audience:
   *  the frequency of a campaign mixing two audiences describes neither. */
  adSetsRecent: Insight[];
  campaigns: Campaign[];
  adSets: AdSet[];
  ads: Ad[];
  images: Record<string, AdImage>;
  conversions: CustomConversion[];
  /** Saved audiences, needed to say anything about who an ad set targets. */
  audiences: CustomAudience[];
  pixels: Record<string, PixelReading>;
};

export type SnapshotResult = {
  snapshot: Snapshot;
  /** Every call that failed, essential or not. */
  missing: string[];
  /**
   * True when everything the analyst needs in order to reason arrived.
   *
   * Not the same as "nothing failed", and the difference matters. If the
   * ads call fails, an ad set looks like it has no ads and the obvious
   * suggestion is to turn it on: that is false information and the
   * analyst must not run on it. If the pixel's stats call fails, two
   * checks have nothing to say and everything else is still true.
   *
   * Treating those the same way was a real bug, found the first time
   * this ran with a properly scoped read-only token: four pixel calls
   * came back denied and the whole analysis would have been skipped over
   * data that was perfectly good.
   */
  complete: boolean;
  /** Calls spent on this snapshot, to keep an eye on the account's quota. */
  calls: number;
};

/**
 * Calls whose absence makes the rest of the picture misleading.
 *
 * Anything not on this list can fail without invalidating what did
 * arrive. The checks that need it simply have nothing to say.
 */
const ESSENTIAL = new Set([
  "account",
  "campaigns",
  "adsets",
  "ads",
  "insights:ad:recent",
  "insights:adset",
]);

/** Keeps a failed call from aborting the run, and records what was lost. */
function collect<T>(result: Result<T>, label: string, missing: string[], fallback: T): T {
  if (result.ok) return result.value;
  console.error(`[snapshot] ${label}: ${result.reason}`);
  missing.push(label);
  return fallback;
}

export async function takeSnapshot(
  client: MetaClient,
  config: Config,
  day: string,
): Promise<SnapshotResult> {
  const missing: string[] = [];
  const account = config.accountId;

  // Yesterday is the last day whose figures have settled. Today's are
  // still filling in and the final hour of any window takes about an
  // hour to publish, so a window ending today compares a full week
  // against a partial one.
  const lastClosed = addDays(day, -1);
  const recent = windowOf(lastClosed, 7);
  const previous = windowOf(addDays(lastClosed, -7), 7);

  const insights = (level: string, range: { since: string; until: string }) =>
    client.list<Insight>(
      `${account}/insights`,
      { level, fields: INSIGHT_FIELDS, time_range: range, limit: 500 },
      4,
    );

  // These do not depend on each other, and the scheduled task they run
  // inside has a deadline. Chaining them spends it for nothing.
  const [status, adsRecent, adsPrevious, adSetsRecent] = await Promise.all([
    client.get<AccountStatus>(account, {
      fields: "name,account_status,disable_reason,currency,timezone_name",
    }),
    insights("ad", recent),
    insights("ad", previous),
    insights("adset", recent),
  ]);

  const [campaigns, adSets, ads, conversions, audiences] = await Promise.all([
    client.list<Campaign>(
      `${account}/campaigns`,
      {
        fields:
          "id,name,objective,effective_status,status,daily_budget,lifetime_budget," +
          "bid_strategy,is_adset_budget_sharing_enabled,start_time,stop_time",
        effective_status: ["ACTIVE", "PAUSED"],
        limit: 100,
      },
      3,
    ),
    client.list<AdSet>(
      `${account}/adsets`,
      { fields: ADSET_FIELDS, effective_status: ["ACTIVE"], limit: 50 },
      3,
    ),
    client.list<Ad>(
      `${account}/ads`,
      { fields: AD_FIELDS, effective_status: ["ACTIVE"], limit: 25 },
      6,
    ),
    client.list<CustomConversion>(
      `${account}/customconversions`,
      { fields: "id,name,is_archived,rule,custom_event_type,data_sources", limit: 100 },
      2,
    ),
    client.list<CustomAudience>(
      `${account}/customaudiences`,
      {
        fields:
          "id,name,subtype,description,time_created,time_content_updated," +
          "rule,rule_aggregation," +
          "approximate_count_lower_bound,approximate_count_upper_bound",
        limit: 100,
      },
      2,
    ),
  ]);

  const snapshot: Snapshot = {
    day,
    accountId: account,
    currency: config.currency,
    timeZone: config.timeZone,
    account: collect(status, "account", missing, null),
    adsRecent: collect(adsRecent, "insights:ad:recent", missing, []),
    adsPrevious: collect(adsPrevious, "insights:ad:previous", missing, []),
    adSetsRecent: collect(adSetsRecent, "insights:adset", missing, []),
    campaigns: collect(campaigns, "campaigns", missing, []),
    adSets: collect(adSets, "adsets", missing, []),
    ads: collect(ads, "ads", missing, []),
    images: {},
    conversions: collect(conversions, "customconversions", missing, []),
    audiences: collect(audiences, "customaudiences", missing, []),
    pixels: {},
  };

  // Sizes are only needed for the creatives actually running, which is
  // what the vertical-in-the-feed check reads. Listing every image the
  // account has ever held is what burns the quota.
  const hashes = [...new Set(snapshot.ads.flatMap(imageHashes))];
  if (hashes.length > 0) {
    const images = await client.list<AdImage>(
      `${account}/adimages`,
      { hashes, fields: "hash,width,height,url", limit: 100 },
      2,
    );
    for (const image of collect(images, "adimages", missing, [] as AdImage[])) {
      snapshot.images[image.hash] = image;
    }
  }

  // Only the node is read here. The `/stats` edge needs ads_management,
  // which this Worker deliberately does not have, so those numbers come
  // from the database via hydratePixelStats: the executor fetches them
  // with the wide token it already holds, where nothing can reach it.
  for (const brand of config.brands) {
    const node = await client.get<Pixel>(brand.pixelId, {
      fields:
        "id,name,is_unavailable,enable_automatic_matching," +
        "first_party_cookie_status,data_use_setting",
    });

    snapshot.pixels[brand.pixelId] = {
      node: collect(node, `pixel:${brand.id}`, missing, null),
      events: [],
      matching: [],
    };
  }

  return {
    snapshot,
    missing,
    calls: client.calls,
    complete: !missing.some((label) => ESSENTIAL.has(label)),
  };
}

/** Every image a running ad could be showing, wherever Meta keeps it. */
export function imageHashes(ad: Ad): string[] {
  const creative = ad.creative;
  if (!creative) return [];
  const found = [
    creative.image_hash,
    creative.object_story_spec?.link_data?.image_hash,
    ...(creative.object_story_spec?.link_data?.child_attachments ?? []).map(
      (card) => card.image_hash,
    ),
    ...(creative.asset_feed_spec?.images ?? []).map((image) => image.hash),
  ];
  return found.filter((hash): hash is string => typeof hash === "string" && hash.length > 0);
}

/**
 * Saves the picture.
 *
 * `complete` is the column that matters, and it means "everything
 * essential arrived", not "nothing failed". A missing ads call makes an
 * ad set look empty, which is false information and stops the analyst.
 * A missing pixel stats call only costs the two checks that read it.
 * `missing` records both kinds either way, so nothing fails silently.
 */
export async function saveSnapshot(db: D1Database, result: SnapshotResult): Promise<void> {
  await db
    .prepare(
      `insert into snapshots (day, taken_at, complete, missing, calls, data)
       values (?, datetime('now'), ?, ?, ?, ?)
       on conflict(day) do update set
         taken_at = excluded.taken_at, complete = excluded.complete,
         missing = excluded.missing, calls = excluded.calls, data = excluded.data`,
    )
    .bind(
      result.snapshot.day,
      result.complete ? 1 : 0,
      JSON.stringify(result.missing),
      result.calls,
      JSON.stringify(result.snapshot),
    )
    .run();
}

export async function loadSnapshot(
  db: D1Database,
  day: string,
): Promise<{ snapshot: Snapshot; complete: boolean } | null> {
  const row = await db
    .prepare("select data, complete from snapshots where day = ?")
    .bind(day)
    .first<{ data: string; complete: number }>();
  if (!row) return null;
  try {
    return { snapshot: JSON.parse(row.data) as Snapshot, complete: row.complete === 1 };
  } catch {
    return null;
  }
}
