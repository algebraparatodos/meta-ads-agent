/**
 * Changes nobody on this side made.
 *
 * Meta applies some of its own recommendations to an account without
 * asking, under the name "automatic adjustments". On this account it
 * took an ad set that had been closed to Instagram on purpose, because
 * that is where 146 of 149 sales came from, and opened it to every
 * placement it has, at twenty-six minutes past midnight. The only trace
 * that reached a person was an email saying the ads had been approved
 * again. Nothing errored, nothing stopped delivering, and a decision made
 * with the numbers in front of it was simply gone.
 *
 * It had done the same thing eight times since February, always around
 * the same minute, adding Facebook Reels to ad sets that did not have
 * it, and switching on "carousel to video" in two running ads.
 *
 * The activity log says who did it. Meta's review and delivery sign as
 * actor `0`; the automatic adjustments sign as `Meta` with a real id.
 * People and system users sign with their own names.
 *
 * Three rules, because the log does not see everything: an ad set can
 * end up on automatic placements, and a creative can end up with an
 * enhancement switched on, without a line in the log that says so. So
 * the log is read for who changed things, and the ads and ad sets that
 * are running are read for what state they are in.
 */

import { brandOf, type Config } from "../config.ts";
import type { Snapshot } from "../meta/snapshot.ts";
import type { Activity, Ad } from "../meta/types.ts";
import type { Finding, RefType } from "./types.ts";

/**
 * A change to the configuration made by Meta's automatic adjustments.
 *
 * Its own run status changes are left out: they are the consequence of
 * the edit, the ads going back to review, and they would turn one change
 * into twelve lines.
 */
export function isAutomaticAdjustment(activity: Activity): boolean {
  return (
    activity.actor_name === "Meta" &&
    typeof activity.actor_id === "string" &&
    activity.actor_id !== "0" &&
    !activity.event_type.endsWith("_run_status")
  );
}

/** Meta's old object names, translated into the ones the queue uses. */
const REF_TYPE: Record<string, RefType> = {
  CAMPAIGN_GROUP: "campaign",
  CAMPAIGN: "adset",
  ADGROUP: "ad",
};

const KIND: Record<RefType, string> = {
  campaign: "campaign",
  adset: "ad set",
  ad: "ad",
  pixel: "pixel",
  site: "site",
};

function campaignIdOf(refType: RefType, id: string, snapshot: Snapshot): string | undefined {
  if (refType === "campaign") return id;
  if (refType === "adset") return snapshot.adSets.find((s) => s.id === id)?.campaign_id;
  return snapshot.ads.find((a) => a.id === id)?.campaign_id;
}

function brandIdOf(campaignId: string | undefined, snapshot: Snapshot, config: Config): string | null {
  const campaign = snapshot.campaigns.find((c) => c.id === campaignId);
  return campaign ? (brandOf(campaign.name, config.brands)?.id ?? null) : null;
}

/** Whether the object is spending today, which is what makes it urgent. */
function isRunning(refType: RefType, id: string, snapshot: Snapshot): boolean {
  if (refType === "adset") return snapshot.adSets.some((s) => s.id === id && s.effective_status === "ACTIVE");
  if (refType === "ad") return snapshot.ads.some((a) => a.id === id && a.effective_status === "ACTIVE");
  return snapshot.campaigns.some((c) => c.id === id && c.effective_status === "ACTIVE");
}

export function metaChangedOnItsOwn(snapshot: Snapshot, config: Config): Finding[] {
  const byObject = new Map<string, Activity[]>();
  for (const activity of snapshot.activities ?? []) {
    if (!isAutomaticAdjustment(activity) || !activity.object_id) continue;
    if (!activity.object_type || !REF_TYPE[activity.object_type]) {
      // Account level, which the queue has no reference type for. Rare,
      // and loud here so that the first one is noticed.
      console.error(`[checks] Meta changed ${activity.object_type} ${activity.object_id} on its own`);
      continue;
    }
    const list = byObject.get(activity.object_id) ?? [];
    list.push(activity);
    byObject.set(activity.object_id, list);
  }

  const findings: Finding[] = [];
  for (const [id, activities] of byObject) {
    const first = activities[0]!;
    const refType = REF_TYPE[first.object_type!]!;
    const name = first.object_name ?? id;
    const what = [...new Set(activities.map((a) => (a.translated_event_type ?? a.event_type).toLowerCase()))];
    const when = activities.map((a) => a.event_time).sort()[0]!;

    findings.push({
      id: "meta_changed_on_its_own",
      severity: isRunning(refType, id, snapshot) ? "urgent" : "notice",
      brandId: brandIdOf(campaignIdOf(refType, id, snapshot), snapshot, config),
      refType,
      refId: id,
      refName: name,
      title: `Meta changed "${name}" on its own`,
      groupTitle: "Meta changed {n} things in the account on its own",
      observed:
        `At ${when} this ${KIND[refType]} had ${what.join(", ")}. Nobody on this ` +
        `side did it: the change is signed by Meta (actor ${first.actor_id}), ` +
        "which is how the automatic adjustments sign, not by a person or by this agent.",
      change:
        "Put it back the way it was decided, and turn off automatic adjustments in " +
        "Ads Manager (Account overview, Automatic adjustments). While they are on, " +
        "Meta keeps undoing decisions like this one, usually overnight.",
      handling: "work",
      reversible: true,
      costIfWrong: "Nothing. It puts back what somebody had already chosen.",
    });
  }

  return findings;
}

/**
 * A running ad set that does not say where it runs.
 *
 * With no `publisher_platforms` Meta places the ads wherever it likes,
 * Facebook, Threads and the Audience Network included. On this account
 * that is never a decision anybody made, and the log does not always
 * show how it got there.
 */
export function automaticPlacements(snapshot: Snapshot, config: Config): Finding[] {
  const findings: Finding[] = [];

  for (const set of snapshot.adSets) {
    if (set.effective_status !== "ACTIVE" || !set.targeting) continue;
    if ((set.targeting.publisher_platforms ?? []).length > 0) continue;

    findings.push({
      id: "automatic_placements",
      severity: "urgent",
      brandId: brandIdOf(set.campaign_id, snapshot, config),
      refType: "adset",
      refId: set.id,
      refName: set.name,
      title: `"${set.name}" is on automatic placements`,
      groupTitle: "{n} ad sets are on automatic placements",
      observed:
        "This ad set does not declare any placement, so Meta decides where its " +
        "money goes, Facebook, Threads and the Audience Network included.",
      change:
        "Declare the placements that were decided for it, sending the targeting " +
        "whole because Meta replaces the field instead of merging it.",
      handling: "work",
      reversible: true,
      costIfWrong: "The learning phase restarts.",
    });
  }

  return findings;
}

/** Every automatic enhancement a creative has switched on. */
export function enhancementsOn(ad: Ad): string[] {
  const features = ad.creative?.degrees_of_freedom_spec?.creative_features_spec ?? {};
  return Object.entries(features)
    .filter(([, value]) => value?.enroll_status === "OPT_IN")
    .map(([key]) => key)
    .sort();
}

/**
 * A running ad whose creative lets Meta rework it.
 *
 * Crops, filters, music, turning a carousel into a video: each one is
 * Meta changing what a person sees, and none of them shows up in the
 * panel's preview. The house rule is every one of them off.
 */
export function creativeEnhancements(snapshot: Snapshot, config: Config): Finding[] {
  const findings: Finding[] = [];

  for (const ad of snapshot.ads) {
    if (ad.effective_status !== "ACTIVE") continue;
    const on = enhancementsOn(ad);
    if (on.length === 0) continue;

    findings.push({
      id: "creative_enhancements_on",
      severity: "notice",
      brandId: brandIdOf(ad.campaign_id, snapshot, config),
      refType: "ad",
      refId: ad.id,
      refName: ad.name,
      title: `"${ad.name}" lets Meta rework its creative`,
      groupTitle: "{n} ads let Meta rework their creative",
      observed: `Its creative has these automatic enhancements switched on: ${on.join(", ")}.`,
      change:
        "Create a new creative from the same post (object_story_id) with every key in " +
        "creative_features_spec set to OPT_OUT, and point the ad at it. Using the same " +
        "post keeps its comments and likes.",
      handling: "work",
      reversible: true,
      costIfWrong: "Nothing. The ad goes back to review for a few minutes.",
    });
  }

  return findings;
}

export const automationChecks = [metaChangedOnItsOwn, automaticPlacements, creativeEnhancements];
