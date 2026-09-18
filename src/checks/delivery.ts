/**
 * The checks that read what the account is doing with the money.
 *
 * The rule that sets every threshold below: a watcher that warns about
 * too much stops being read. Each check has to describe something you
 * would do differently tomorrow. If the honest reaction is "yes, I know,
 * that is normal", the check does not belong here.
 */

import { brandOf, thresholdsFor, type Config } from "../config.ts";
import type { Snapshot } from "../meta/snapshot.ts";
import type { Insight } from "../meta/types.ts";
import { countResults, n } from "../meta/types.ts";
import { money, percent, type Finding } from "./types.ts";

function brandFor(campaignName: string | undefined, config: Config): string | null {
  if (!campaignName) return null;
  return brandOf(campaignName, config.brands)?.id ?? null;
}

/**
 * Money going out with nothing coming back.
 *
 * The only check here that is urgent, because every hour it stays true
 * costs more than the last. It looks at the day in progress rather than
 * waiting for it to close, since waiting for the day to close is waiting
 * for the whole budget to be spent.
 *
 * The advice attached matters as much as the alert. Clicks arriving with
 * no events is usually a measurement fault, not an advertising one, and
 * the expensive mistake is to rewrite a working ad because the pixel
 * stopped reporting.
 */
export function spendingWithoutResults(snapshot: Snapshot, config: Config): Finding[] {
  const { currency } = config;
  const findings: Finding[] = [];

  for (const row of snapshot.adSetsRecent) {
    // Per brand, because what counts as a result is not the same for
    // both. One brand's purchase event may include things nobody paid
    // for, so it is measured further up the funnel instead.
    const brandId = brandFor(row.campaign_name, config);
    const thresholds = thresholdsFor(config, brandId);

    const spend = n(row.spend);
    if (spend < thresholds.spendWithoutResults) continue;
    if (countResults(row, thresholds.resultActions) > 0) continue;

    findings.push({
      id: "spending_without_results",
      severity: "urgent",
      brandId,
      refType: "adset",
      refId: row.adset_id ?? "",
      refName: row.adset_name ?? "",
      title: `${money(spend, currency)} and no results in "${row.adset_name}"`,
      observed:
        `Over the window it spent ${money(spend, currency)} and registered none ` +
        `of ${thresholds.resultActions.join(", ")}. It has ` +
        `${n(row.inline_link_clicks).toLocaleString("en-GB")} link clicks and ` +
        `${n(row.impressions).toLocaleString("en-GB")} impressions.`,
      change:
        "Before touching the ad, rule out the pixel and the landing page. " +
        "Clicks arriving with no events usually means the measurement broke, " +
        "not the advertising, and rewriting a working ad because of it is the " +
        "expensive version of this mistake.",
      reversible: true,
      costIfWrong: `About ${money(spend / 7, currency)} a day while it keeps running.`,
    });
  }

  return findings;
}

/**
 * One ad in an ad set taking the budget without converting.
 *
 * This is the one that pays for the project. An ad set optimising for
 * landing page views hands its money to whichever ad produces the
 * cheapest views, and the most entertaining creative produces cheap
 * views from people who came to watch, not to buy. Meta is doing exactly
 * what it was asked. Nobody told it the button mattered.
 *
 * The algorithm will never correct this, because by its own objective
 * that ad is the best of the set. It has to be read at ad level and cut
 * by hand, and that is why the snapshot pays for `level=ad`.
 */
export function lopsidedSpend(snapshot: Snapshot, config: Config): Finding[] {
  const { currency } = config;
  const bySet = new Map<string, Insight[]>();

  for (const row of snapshot.adsRecent) {
    if (!row.adset_id) continue;
    const list = bySet.get(row.adset_id) ?? [];
    list.push(row);
    bySet.set(row.adset_id, list);
  }

  const active = new Set(snapshot.ads.filter((a) => a.effective_status === "ACTIVE").map((a) => a.id));
  const findings: Finding[] = [];

  for (const [, rows] of bySet) {
    if (rows.length < 2) continue;

    const brandId = brandFor(rows[0]?.campaign_name, config);
    const thresholds = thresholdsFor(config, brandId);

    const total = rows.reduce((sum, row) => sum + n(row.spend), 0);
    if (total < thresholds.spendWithoutResults) continue;

    const sorted = [...rows].sort((a, b) => n(b.spend) - n(a.spend));
    const top = sorted[0];
    if (!top || !top.ad_id || !active.has(top.ad_id)) continue;

    const share = n(top.spend) / total;
    if (share < thresholds.maxSpendShare) continue;
    if (countResults(top, thresholds.resultActions) > 0) continue;

    // Only worth raising if a sibling on less money is doing better. On
    // its own, a big share with no results is the check above, and
    // saying it twice in one morning is how an inbox gets filtered.
    const better = sorted
      .slice(1)
      .find(
        (row) =>
          countResults(row, thresholds.resultActions) > 0 &&
          n(row.spend) < n(top.spend) / 2,
      );
    if (!better) continue;

    findings.push({
      id: "lopsided_spend",
      handling: "auto",
      severity: "urgent",
      brandId,
      refType: "ad",
      refId: top.ad_id,
      refName: top.ad_name ?? "",
      title: `"${top.ad_name}" takes ${percent(share)} of the set and converts nothing`,
      observed:
        `In "${top.adset_name}" it spent ${money(n(top.spend), currency)} of ` +
        `${money(total, currency)} with no results, while "${better.ad_name}" spent ` +
        `${money(n(better.spend), currency)} and produced ` +
        `${countResults(better, thresholds.resultActions)}.`,
      change:
        `Pause "${top.ad_name}" and let the budget fall to the ads that are ` +
        "converting. The algorithm will not do this on its own: against the " +
        "objective it was given, that ad is the best in the set.",
      action: { type: "pause_ad", adId: top.ad_id },
      reversible: true,
      costIfWrong:
        `About ${money(n(top.spend) / 7, currency)} a day of reach, recovered ` +
        "by turning it back on.",
    });
  }

  return findings;
}

/** The same people seeing the same ad too many times. */
export function highFrequency(snapshot: Snapshot, config: Config): Finding[] {
  const active = new Set(
    snapshot.adSets.filter((a) => a.effective_status === "ACTIVE").map((a) => a.id),
  );
  const findings: Finding[] = [];

  for (const row of snapshot.adSetsRecent) {
    // Insights for a window include what was paused inside it, and
    // warning about a set that is already off is correct and useless.
    if (!row.adset_id || !active.has(row.adset_id)) continue;

    const brandId = brandFor(row.campaign_name, config);
    const thresholds = thresholdsFor(config, brandId);

    const frequency = n(row.frequency);
    if (frequency < thresholds.maxFrequency) continue;
    if (n(row.impressions) < thresholds.minImpressions) continue;

    findings.push({
      id: "high_frequency",
      handling: "watch",
      severity: "notice",
      brandId,
      refType: "adset",
      refId: row.adset_id,
      refName: row.adset_name ?? "",
      title: `Frequency ${frequency.toFixed(2)} in "${row.adset_name}"`,
      observed:
        `Each person in that audience saw the ad ${frequency.toFixed(2)} times on ` +
        `average, across ${n(row.reach).toLocaleString("en-GB")} people.`,
      change:
        "The cheapest move before touching the audience or the budget is to " +
        "open up placements, reels and stories, or change the creative.",
      reversible: true,
    });
  }

  return findings;
}

/**
 * Fatigue, meaning CTR falling and CPM rising together.
 *
 * Both conditions are required on purpose. CTR alone falls when the mix
 * of the audience changes; CPM alone rises when the auction gets busier,
 * a sale week or a local season. It is the two at once that describes an
 * ad people have stopped seeing.
 */
export function fatigue(snapshot: Snapshot, config: Config): Finding[] {
  const before = new Map(snapshot.adsPrevious.filter((r) => r.ad_id).map((r) => [r.ad_id!, r]));
  const active = new Set(snapshot.ads.filter((a) => a.effective_status === "ACTIVE").map((a) => a.id));
  const findings: Finding[] = [];

  for (const now of snapshot.adsRecent) {
    if (!now.ad_id || !active.has(now.ad_id)) continue;
    const then = before.get(now.ad_id);
    if (!then) continue;

    const brandId = brandFor(now.campaign_name, config);
    const thresholds = thresholdsFor(config, brandId);

    if (n(now.impressions) < thresholds.minImpressions) continue;
    if (n(then.impressions) < thresholds.minImpressions) continue;

    const ctrBefore = n(then.ctr);
    const cpmBefore = n(then.cpm);
    if (ctrBefore <= 0 || cpmBefore <= 0) continue;

    const ctrDrop = (ctrBefore - n(now.ctr)) / ctrBefore;
    const cpmRise = (n(now.cpm) - cpmBefore) / cpmBefore;
    if (ctrDrop < thresholds.ctrDrop || cpmRise < thresholds.cpmRise) continue;

    findings.push({
      id: "fatigue",
      severity: "notice",
      brandId,
      refType: "ad",
      refId: now.ad_id,
      refName: now.ad_name ?? "",
      title: `"${now.ad_name}" is wearing out`,
      observed:
        `Against the same length of time before, its click through rate fell ` +
        `${percent(ctrDrop)} (${ctrBefore.toFixed(2)}% to ${n(now.ctr).toFixed(2)}%) ` +
        `while its cost per thousand rose ${percent(cpmRise)} ` +
        `(${cpmBefore.toFixed(2)} to ${n(now.cpm).toFixed(2)}). Both together mean ` +
        "the audience has stopped noticing it.",
      change: "Replace the creative. The audience and the offer are not the problem here.",
      reversible: true,
    });
  }

  return findings;
}

/**
 * An ad set bidding on an event it will never get enough of.
 *
 * Meta needs roughly fifty events of the optimisation type per week to
 * leave the learning phase, ten if it is optimising for purchase. Below
 * that it never finishes learning and it is guessing, permanently.
 *
 * For a small advertiser this is the most useful unflattering thing the
 * agent can say, and it is better said before the campaign runs for a
 * month: with low volume, optimise higher up the funnel, where there is
 * ten times the traffic.
 */
export function unreachableLearning(snapshot: Snapshot, config: Config): Finding[] {
  const byId = new Map(snapshot.adSetsRecent.filter((r) => r.adset_id).map((r) => [r.adset_id!, r]));
  const findings: Finding[] = [];

  for (const adSet of snapshot.adSets) {
    if (adSet.effective_status !== "ACTIVE") continue;
    if (adSet.optimization_goal !== "OFFSITE_CONVERSIONS") continue;

    const row = byId.get(adSet.id);
    if (!row) continue;

    const brandId = brandFor(row.campaign_name, config);
    const thresholds = thresholdsFor(config, brandId);
    if (n(row.impressions) < thresholds.minImpressions) continue;

    const event = adSet.promoted_object?.custom_event_type ?? "";
    const needed = event === "PURCHASE" ? 10 : 50;
    const got = countResults(row, event ? [event.toLowerCase()] : thresholds.resultActions);
    if (got >= needed) continue;

    findings.push({
      id: "unreachable_learning",
      severity: "notice",
      brandId,
      refType: "adset",
      refId: adSet.id,
      refName: adSet.name,
      title: `"${adSet.name}" cannot finish learning on this event`,
      observed:
        `It bids on ${event || "a website conversion"} and got ${got} of them in a ` +
        `week, against the ${needed} Meta needs to leave the learning phase. ` +
        "Below that it keeps optimising on guesswork.",
      change:
        "Either raise the budget until the event happens often enough, or bid " +
        "on an event further up the funnel, which happens five to fifteen " +
        "times more often. Changing the event means cloning the ad set: a " +
        "published one will not accept a new optimisation event, and the " +
        "clone starts learning from zero.",
      reversible: false,
      costIfWrong: "A clone restarts the learning phase, which is a few days of worse delivery.",
    });
  }

  return findings;
}

/** Attribution set to something other than the house standard. */
export function nonStandardAttribution(snapshot: Snapshot, config: Config): Finding[] {
  const findings: Finding[] = [];

  for (const adSet of snapshot.adSets) {
    if (adSet.effective_status !== "ACTIVE") continue;
    const spec = adSet.attribution_spec;
    if (!spec || spec.length === 0) continue;

    const click = spec.find((s) => s.event_type === "CLICK_THROUGH");
    if (click?.window_days === 7) continue;

    findings.push({
      id: "non_standard_attribution",
      severity: "notice",
      brandId: brandFor(adSet.name, config),
      refType: "adset",
      refId: adSet.id,
      refName: adSet.name,
      title: `"${adSet.name}" counts conversions over a different window`,
      observed: `Its attribution is ${spec
        .map((s) => `${s.window_days}d ${s.event_type.toLowerCase().replace("_", " ")}`)
        .join(", ")}, not the seven day click this account compares everything on.`,
      change:
        "Set it to seven day click so its numbers can be read next to the " +
        "others. Attribution is frozen once an ad set is published, so this " +
        "means cloning it.",
      reversible: false,
    });
  }

  return findings;
}

/**
 * Campaign level budget sharing, when the budget lives in the ad sets.
 *
 * With it on, Meta moves up to a fifth of one ad set's budget to
 * another, and the split somebody decided between a warm audience and a
 * cold one stops being the split they decided. It is a reasonable
 * setting; it is just rarely the one that was chosen deliberately.
 */
export function sharedBudget(snapshot: Snapshot, config: Config): Finding[] {
  const findings: Finding[] = [];

  for (const campaign of snapshot.campaigns) {
    if (campaign.effective_status !== "ACTIVE") continue;
    if (!campaign.is_adset_budget_sharing_enabled) continue;
    if (campaign.daily_budget || campaign.lifetime_budget) continue;

    findings.push({
      id: "shared_budget",
      severity: "notice",
      brandId: brandFor(campaign.name, config),
      refType: "campaign",
      refId: campaign.id,
      refName: campaign.name,
      title: `"${campaign.name}" lets Meta move budget between ad sets`,
      observed:
        "Budget sharing is on and the budgets live in the ad sets, so up to a " +
        "fifth of one can be moved to another.",
      change:
        "Turn sharing off if the split between those audiences was chosen on " +
        "purpose. Leave it on if the point was to let Meta find the winner.",
      reversible: true,
    });
  }

  return findings;
}

/** A campaign that cannot be attributed to any brand on the account. */
export function unattributedCampaign(snapshot: Snapshot, config: Config): Finding[] {
  if (config.brands.length < 2) return [];
  const findings: Finding[] = [];

  for (const campaign of snapshot.campaigns) {
    if (campaign.effective_status !== "ACTIVE") continue;
    if (brandOf(campaign.name, config.brands)) continue;

    findings.push({
      id: "unattributed_campaign",
      severity: "notice",
      brandId: null,
      refType: "campaign",
      refId: campaign.id,
      refName: campaign.name,
      title: `"${campaign.name}" does not say which brand it belongs to`,
      observed:
        `Its name starts with none of ${config.brands
          .map((b) => b.campaignPrefix)
          .join(", ")}, so its ads cannot be checked against the right pixel.`,
      change:
        "Rename it with the brand prefix. On an account holding two " +
        "businesses, the name is the only thing that says which is which.",
      reversible: true,
    });
  }

  return findings;
}

/** The account itself, or an ad, stopped by Meta rather than by a person. */
export function stoppedByMeta(snapshot: Snapshot, _config: Config): Finding[] {
  const findings: Finding[] = [];
  const status = snapshot.account?.account_status;

  const reasons: Record<number, string> = {
    2: "it is disabled",
    3: "it is pending review",
    7: "it is pending closure",
    9: "it is in a grace period after a failed payment",
    101: "it is closed",
  };

  if (typeof status === "number" && status !== 1) {
    findings.push({
      id: "account_stopped",
      handling: "watch",
      severity: "urgent",
      brandId: null,
      refType: "campaign",
      refId: snapshot.accountId,
      refName: snapshot.account?.name ?? snapshot.accountId,
      title: "The ad account is not delivering",
      observed: `Meta reports status ${status}${reasons[status] ? `, ${reasons[status]}` : ""}.`,
      change:
        "Until that clears, nothing is shown to anybody whatever the budget " +
        "says. It is resolved in the account's billing or quality section.",
      reversible: true,
    });
  }

  return findings;
}

export const deliveryChecks = [
  stoppedByMeta,
  spendingWithoutResults,
  lopsidedSpend,
  highFrequency,
  fatigue,
  unreachableLearning,
  nonStandardAttribution,
  sharedBudget,
  unattributedCampaign,
];

/**
 * Ads Meta is still reviewing.
 *
 * Not a finding and deliberately not one: an ad created this morning
 * always passes through review and warning about that is warning that
 * everything is normal. It is carried into the analyst's summary as
 * context, so a quiet afternoon is not read as fatigue when the real
 * reason is that we changed something a few hours ago.
 */
export function inReview(snapshot: Snapshot): { id: string; name: string }[] {
  return snapshot.ads
    .filter((ad) => ad.status === "ACTIVE" && ad.effective_status === "PENDING_REVIEW")
    .map((ad) => ({ id: ad.id, name: ad.name }));
}
