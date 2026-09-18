/**
 * Everything that is true about one installation and false about the
 * next: which ad account, which brands share it, which pixel belongs to
 * which, and where the thresholds sit.
 *
 * None of it is in the code. It is read from the database at the start
 * of every run, so the same Worker serves any account and this
 * repository can be public without carrying anyone's business inside it.
 *
 * The one rule worth keeping when adding a setting: **a field that is
 * missing or unreadable falls back to its default, it does not
 * invalidate the row**. The day a new threshold is added, saved
 * configuration will not have it, and throwing away the whole row for
 * that would reset every threshold somebody had just tuned.
 */

export type Brand = {
  id: string;
  displayName: string;
  /** Campaigns belonging to this brand start with it. */
  campaignPrefix: string;
  pixelId: string;
  /** What `conversion_domain` should say on its ads. */
  domain: string | null;
  /**
   * Thresholds that differ for this brand, merged over the account's.
   *
   * Two businesses sharing an account are usually two different
   * businesses, and the same number means different things to each. A
   * cost per lead of 13 EUR is a disaster for one selling an online
   * course and normal for one filling a physical workshop within twelve
   * kilometres. Forcing both through one set of numbers produces an
   * agent that shouts at the healthy one and stays quiet about the sick
   * one.
   *
   * It also covers the case where a brand's purchase event cannot be
   * trusted: `resultActions` can be set to something further up the
   * funnel for that brand alone.
   */
  thresholds?: Partial<Thresholds>;
};

export type Thresholds = {
  /** Above this, a person has seen the same ad too often. */
  maxFrequency: number;
  frequencyDays: number;
  /** Money one ad set may burn without a single result before it is urgent. */
  spendWithoutResults: number;
  spendDays: number;
  /** How far CTR must fall, 0.25 being 25 percent. */
  ctrDrop: number;
  /** And how far CPM must rise at the same time. */
  cpmRise: number;
  fatigueDays: number;
  /** Below this, the numbers are coincidence and nothing is compared. */
  minImpressions: number;
  /**
   * Events needed before the match rate means anything.
   *
   * Much lower than `minImpressions` and deliberately a separate number.
   * Impressions arrive in tens of thousands; pixel events arrive in
   * dozens, and the window `/stats` reports on is hours, not days.
   * Sharing one threshold between them means the match rate check can
   * never fire on a small advertiser, however bad the matching is,
   * which is exactly the advertiser it matters most to.
   */
  minEventsForMatching: number;
  /** In an ad set, the share one ad may take before it is questioned. */
  maxSpendShare: number;
  /** Share of events Meta could not match to a person before it is flagged. */
  maxUnmatchedShare: number;
  /** Which Meta actions count as a result worth having. */
  resultActions: string[];
  /**
   * Whether to flag ad copy that uses characters outside ASCII.
   *
   * Off by default, because it is a precaution and not a fault: accented
   * copy is correct copy. Worth turning on only for an account that has
   * already had text arrive at Meta as replacement characters, since
   * that damage cannot be undone by reading the API back.
   */
  asciiOnlyCopy: boolean;
  /**
   * Days a hand-uploaded audience may go without being refreshed before
   * it is worth mentioning, if something is still targeting it.
   *
   * A list uploaded from a file never refreshes itself. It is a
   * photograph of who had signed up the day somebody exported it, and
   * nothing in Meta says how old the photograph is.
   */
  staleAudienceDays: number;
  /**
   * Days a website audience may exist and stay empty before it is worth
   * saying so.
   *
   * An audience that has nobody in it weeks after it was created is not
   * a small audience: it is an event that is not arriving. Nothing in
   * Meta distinguishes the two.
   */
  emptyAudienceDays: number;
};

export type Config = {
  enabled: boolean;
  accountId: string;
  /** Meta cuts its days in this zone. Asking for "the last 3 days" with
   *  another calendar returns a different range than you think. */
  timeZone: string;
  currency: string;
  brands: Brand[];
  /**
   * Pixels this account used to use and should not use again.
   *
   * Worth naming rather than ignoring. A retired pixel is not a
   * stranger's: ads cloned from old ones inherit it, it keeps receiving
   * events from pages nobody updated, and those events build audiences
   * and count conversions that no live campaign can see. An unknown
   * pixel is somebody else's business and is left alone; a retired one
   * is ours and is a fault.
   */
  retiredPixels: { id: string; name: string }[];
  /**
   * Hosts or paths where a customer goes AFTER buying: a members area, a
   * course platform, an account dashboard, a thank you page.
   *
   * They matter because the pixel does not distinguish them from the
   * shop front. A retargeting audience built on "visited the site" will
   * quietly include everyone who logged in to use what they already
   * paid for, and the campaign chasing new customers spends part of its
   * budget on them. Nothing in Meta reports this.
   */
  customerAreas: string[];
  thresholds: Thresholds;
  /** Where proposals are emailed, and who may approve them by replying. */
  notify: { to: string; from: string; replyDomain: string; approvers: string[] };
  /** Hard ceilings for the LLM half, in euros. */
  budget: { dailyEur: number; monthlyEur: number };
  /** Most proposals to email in one day. */
  maxProposalsPerDay: number;
  /** Days a proposal waits for a decision before it is too stale to apply. */
  proposalTtlDays: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  maxFrequency: 2.5,
  frequencyDays: 7,
  spendWithoutResults: 15,
  spendDays: 3,
  ctrDrop: 0.25,
  cpmRise: 0.25,
  fatigueDays: 3,
  minImpressions: 1000,
  minEventsForMatching: 100,
  maxSpendShare: 0.55,
  maxUnmatchedShare: 0.5,
  resultActions: ["purchase", "lead", "complete_registration"],
  asciiOnlyCopy: false,
  staleAudienceDays: 180,
  emptyAudienceDays: 21,
};

function num(value: unknown, fallback: number, min = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min
    ? value
    : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function readThresholds(raw: unknown): Thresholds {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_THRESHOLDS;
  const r = raw as Record<string, unknown>;
  const actions = Array.isArray(r.resultActions)
    ? r.resultActions.filter((a): a is string => typeof a === "string" && a.length > 0)
    : [];

  return {
    maxFrequency: num(r.maxFrequency, DEFAULT_THRESHOLDS.maxFrequency, 1),
    frequencyDays: num(r.frequencyDays, DEFAULT_THRESHOLDS.frequencyDays, 1),
    spendWithoutResults: num(r.spendWithoutResults, DEFAULT_THRESHOLDS.spendWithoutResults),
    spendDays: num(r.spendDays, DEFAULT_THRESHOLDS.spendDays, 1),
    ctrDrop: num(r.ctrDrop, DEFAULT_THRESHOLDS.ctrDrop),
    cpmRise: num(r.cpmRise, DEFAULT_THRESHOLDS.cpmRise),
    fatigueDays: num(r.fatigueDays, DEFAULT_THRESHOLDS.fatigueDays, 1),
    minImpressions: num(r.minImpressions, DEFAULT_THRESHOLDS.minImpressions),
    minEventsForMatching: num(
      r.minEventsForMatching, DEFAULT_THRESHOLDS.minEventsForMatching, 1),
    maxSpendShare: num(r.maxSpendShare, DEFAULT_THRESHOLDS.maxSpendShare),
    maxUnmatchedShare: num(r.maxUnmatchedShare, DEFAULT_THRESHOLDS.maxUnmatchedShare),
    resultActions: actions.length > 0 ? actions : DEFAULT_THRESHOLDS.resultActions,
    asciiOnlyCopy:
      typeof r.asciiOnlyCopy === "boolean"
        ? r.asciiOnlyCopy
        : DEFAULT_THRESHOLDS.asciiOnlyCopy,
    staleAudienceDays: num(r.staleAudienceDays, DEFAULT_THRESHOLDS.staleAudienceDays, 1),
    emptyAudienceDays: num(r.emptyAudienceDays, DEFAULT_THRESHOLDS.emptyAudienceDays, 1),
  };
}

function readRetiredPixels(raw: unknown): { id: string; name: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => ({ id: str(entry.id, ""), name: str(entry.name, "retired pixel") }))
    .filter((pixel) => pixel.id.length > 0);
}

function parse(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * Reads the installation out of D1.
 *
 * Returns null when there is nothing configured yet, which is what a
 * fresh deployment looks like. That is not an error and it must not
 * page anyone: the Worker simply has nothing to watch.
 */
export async function loadConfig(db: D1Database): Promise<Config | null> {
  const [settingRows, brandRows] = await Promise.all([
    db.prepare("select key, value from settings").all<{ key: string; value: string }>(),
    db
      .prepare(
        "select id, display_name, campaign_prefix, pixel_id, domain, thresholds " +
        "from brands order by id",
      )
      .all<{
        id: string;
        display_name: string;
        campaign_prefix: string;
        pixel_id: string;
        domain: string | null;
        thresholds: string | null;
      }>(),
  ]);

  const settings = new Map<string, unknown>();
  for (const row of settingRows.results ?? []) settings.set(row.key, parse(row.value));

  const account = settings.get("account");
  if (!account || typeof account !== "object") return null;
  const a = account as Record<string, unknown>;
  const accountId = str(a.id, "");
  if (!accountId) return null;

  const notifyRaw = (settings.get("notify") ?? {}) as Record<string, unknown>;
  const budgetRaw = (settings.get("budget") ?? {}) as Record<string, unknown>;
  const approvers = Array.isArray(notifyRaw.approvers)
    ? notifyRaw.approvers.filter((x): x is string => typeof x === "string")
    : [];

  return {
    enabled: settings.get("enabled") !== false,
    accountId: accountId.startsWith("act_") ? accountId : `act_${accountId}`,
    timeZone: str(a.timeZone, "UTC"),
    currency: str(a.currency, "EUR"),
    brands: (brandRows.results ?? []).map((b) => {
      const own = parse(b.thresholds);
      return {
        id: b.id,
        displayName: b.display_name,
        campaignPrefix: b.campaign_prefix,
        pixelId: b.pixel_id,
        domain: b.domain,
        ...(own && typeof own === "object" && !Array.isArray(own)
          ? { thresholds: own as Partial<Thresholds> }
          : {}),
      };
    }),
    retiredPixels: readRetiredPixels(settings.get("retiredPixels")),
    customerAreas: Array.isArray(settings.get("customerAreas"))
      ? (settings.get("customerAreas") as unknown[]).filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        )
      : [],
    thresholds: readThresholds(settings.get("thresholds")),
    notify: {
      to: str(notifyRaw.to, ""),
      from: str(notifyRaw.from, ""),
      replyDomain: str(notifyRaw.replyDomain, ""),
      approvers: approvers.length > 0 ? approvers : [str(notifyRaw.to, "")].filter(Boolean),
    },
    budget: {
      dailyEur: num(budgetRaw.dailyEur, 0.065),
      monthlyEur: num(budgetRaw.monthlyEur, 2),
    },
    maxProposalsPerDay: num(settings.get("maxProposalsPerDay"), 3, 1),
    proposalTtlDays: num(settings.get("proposalTtlDays"), 7, 1),
  };
}

/**
 * The thresholds that apply to one brand, or the account's when the
 * finding does not belong to a brand.
 *
 * Merged field by field rather than replaced: a brand that only wants a
 * different result event should not have to restate every other number,
 * and if it did, the day a threshold is added it would silently keep the
 * old default for that brand alone.
 */
export function thresholdsFor(config: Config, brandId: string | null): Thresholds {
  if (!brandId) return config.thresholds;
  const brand = config.brands.find((b) => b.id === brandId);
  if (!brand?.thresholds) return config.thresholds;
  return { ...config.thresholds, ...brand.thresholds };
}

/** Every pixel this account is supposed to be using today. */
export function livePixels(config: Config): Set<string> {
  return new Set(config.brands.map((brand) => brand.pixelId));
}

/**
 * Which brand a campaign belongs to, or null when it cannot be told.
 *
 * Not being able to tell is a finding, not a default. An account with
 * two pixels will happily attribute one brand's conversions to the
 * other and nothing in Meta will complain.
 */
export function brandOf(campaignName: string, brands: Brand[]): Brand | null {
  const name = campaignName.trim().toUpperCase();
  for (const brand of brands) {
    if (name.startsWith(brand.campaignPrefix.toUpperCase())) return brand;
  }
  return null;
}
