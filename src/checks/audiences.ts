/**
 * Who ends up inside the audiences the campaigns are aimed at.
 *
 * Meta will not tell you this and the panel makes it hard to see: an
 * audience is a name and a headcount, and what it actually contains is a
 * rule nobody reads again after the day it was made.
 *
 * The failure this exists for is the one that costs money quietly. A
 * website retargeting audience built from "anyone who visited the site"
 * also collects everyone who logs into the members area, so a campaign
 * chasing new customers spends its budget showing the ad to people who
 * already bought. Nothing reports it. The audience grows, the campaign
 * delivers, and the cost per acquisition drifts up for reasons that look
 * like bad luck.
 */

import { brandOf, type Config } from "../config.ts";
import type { Snapshot } from "../meta/snapshot.ts";
import type { CustomAudience } from "../meta/types.ts";
import type { Finding } from "./types.ts";

/**
 * The rule as text, whatever shape Meta felt like returning.
 *
 * It comes back as a JSON string on some audience subtypes and as a
 * parsed object on others, and the difference is not documented. Since
 * every use here is a substring search, flattening it to text is both
 * simpler and immune to the shape changing again.
 */
function ruleText(audience: CustomAudience): string {
  const rule = audience.rule;
  if (!rule) return "";
  if (typeof rule === "string") return rule;
  try {
    return JSON.stringify(rule);
  } catch {
    return "";
  }
}

/** Website audiences that are actually in use by a live ad set. */
function audiencesInUse(snapshot: Snapshot): Set<string> {
  const used = new Set<string>();
  for (const adSet of snapshot.adSets) {
    if (adSet.effective_status !== "ACTIVE") continue;
    for (const audience of adSet.targeting?.custom_audiences ?? []) used.add(audience.id);
    for (const audience of adSet.targeting?.excluded_custom_audiences ?? []) {
      used.add(audience.id);
    }
  }
  return used;
}

/**
 * A website audience that scoops up the customer area.
 *
 * Only raised for audiences a live ad set is actually targeting, or the
 * check would report every audience anybody ever made. An audience
 * nobody uses is clutter, not a fault.
 */
export function audienceIncludesCustomerArea(
  snapshot: Snapshot,
  config: Config,
): Finding[] {
  const areas = config.customerAreas ?? [];
  if (areas.length === 0) return [];

  const used = audiencesInUse(snapshot);
  const findings: Finding[] = [];

  for (const audience of snapshot.audiences) {
    if (audience.subtype !== "WEBSITE") continue;
    if (!used.has(audience.id)) continue;

    const rule = ruleText(audience);
    if (!rule) continue;

    // Named in the rule at all means it is either being included or
    // excluded, and an exclusion is the fix, not the fault.
    const swept = areas.filter(
      (area) => !rule.includes(area) && !rule.includes(area.replace(/^www\./, "")),
    );
    if (swept.length === 0) continue;

    findings.push({
      id: "audience_includes_customer_area",
      severity: "notice",
      brandId: null,
      refType: "site",
      refId: audience.id,
      refName: audience.name,
      title: `"${audience.name}" is collecting people who already bought`,
      observed:
        `It is a website audience aimed at by a live ad set, and its rule says ` +
        `nothing about ${swept.join(", ")}, which is where customers go after ` +
        "they buy. Every visit to that area adds someone to this audience.",
      change:
        `Add a rule excluding ${swept.join(", ")}, or take the pixel off the ` +
        "customer area if nothing is measured there any more. An audience " +
        "rule cannot be edited after the fact, so this means building a " +
        "replacement and pointing the ad set at it.",
      reversible: true,
      costIfWrong:
        "A smaller audience. If the campaign was deliberately aimed at " +
        "existing customers, this is the wrong change and the audience is " +
        "already right.",
    });
  }

  return findings;
}

/**
 * A live ad set chasing new customers that excludes nobody.
 *
 * Not the same failure as above and it happens for a different reason:
 * the audience is fine, it is the ad set that forgot to subtract. It is
 * easy to do, because exclusions are the last field anybody fills in and
 * the campaign works perfectly without them.
 *
 * Only raised when the account has audiences that could be excluded. On
 * an account with none, saying "you excluded nobody" is not advice.
 */
export function noExclusions(snapshot: Snapshot, config: Config): Finding[] {
  const excludable = snapshot.audiences.filter(
    (a) => (a.approximate_count_lower_bound ?? 0) > 100,
  );
  if (excludable.length === 0) return [];

  const findings: Finding[] = [];

  for (const adSet of snapshot.adSets) {
    if (adSet.effective_status !== "ACTIVE") continue;

    const excluded = adSet.targeting?.excluded_custom_audiences ?? [];
    if (excluded.length > 0) continue;

    const campaign = snapshot.campaigns.find((c) => c.id === adSet.campaign_id);
    // Only for campaigns that are trying to sell or capture. A campaign
    // built to reach existing customers should not exclude them.
    const objective = campaign?.objective ?? "";
    if (!["OUTCOME_SALES", "OUTCOME_LEADS"].includes(objective)) continue;

    findings.push({
      id: "no_exclusions",
      severity: "notice",
      brandId: campaign ? (brandOf(campaign.name, config.brands)?.id ?? null) : null,
      refType: "adset",
      refId: adSet.id,
      refName: adSet.name,
      title: `"${adSet.name}" excludes nobody`,
      groupTitle: "{n} ad sets exclude nobody",
      observed:
        `It is a ${objective === "OUTCOME_SALES" ? "sales" : "lead"} ad set with no ` +
        `excluded audiences, and the account has ${excludable.length} audiences big ` +
        "enough to exclude. Part of its budget is going to people who already " +
        "did the thing it is paying for.",
      change:
        "Exclude whoever already bought, already enquired or is already on the " +
        "list. Exclusions can be edited on a published ad set, so this one is " +
        "cheap to fix and cheap to undo.",
      reversible: true,
    });
  }

  return findings;
}

export const audienceChecks = [audienceIncludesCustomerArea, noExclusions];
