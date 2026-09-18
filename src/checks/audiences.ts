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

import { brandOf, thresholdsFor, type Config } from "../config.ts";
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

/**
 * A hand-uploaded list that has not been refreshed, and is being used.
 *
 * The only kind of audience that does not maintain itself. A website
 * audience fills from the pixel, an engagement one from Instagram, but a
 * list uploaded from a file is frozen the moment it is uploaded: it is a
 * photograph of who had signed up that day, and it keeps being targeted,
 * and excluded, long after it stopped describing anybody.
 *
 * Nothing surfaces this. The audience shows a healthy size, appears in
 * the targeting picker like any other, and Meta never mentions its age.
 * The campaign runs and the money goes to people who signed up a year
 * ago, while the ones who signed up last month are not in it at all.
 *
 * Only raised for audiences a live ad set actually uses. There is no
 * point telling somebody that a list they are not targeting is old.
 */
export function staleUploadedAudience(snapshot: Snapshot, config: Config): Finding[] {
  const used = audiencesInUse(snapshot);
  const findings: Finding[] = [];
  const limit = thresholdsFor(config, null).staleAudienceDays;
  const now = Date.now() / 1000;

  for (const audience of snapshot.audiences) {
    // Only the uploaded kind. Everything else refreshes on its own and
    // an old timestamp there means nothing.
    if (audience.subtype !== "CUSTOM") continue;
    if (!used.has(audience.id)) continue;

    const updated = audience.time_content_updated;
    if (!updated) continue;

    const days = Math.floor((now - updated) / 86400);
    if (days < limit) continue;

    const size = audience.approximate_count_lower_bound ?? 0;
    const excludedOnly = isOnlyExcluded(snapshot, audience.id);

    findings.push({
      id: "stale_uploaded_audience",
      severity: "notice",
      brandId: null,
      refType: "site",
      refId: audience.id,
      refName: audience.name,
      title: `"${audience.name}" was last updated ${days} days ago`,
      groupTitle: "{n} audiences in use have not been refreshed in months",
      observed:
        `It is a list uploaded from a file, so it never refreshes itself, and a ` +
        `live ad set is still ${excludedOnly ? "excluding" : "targeting"} it. It has ` +
        `about ${size.toLocaleString("en-GB")} people in it, all of whom were in it ` +
        `${days} days ago. Nobody who arrived since is.`,
      change: excludedOnly
        ? "Export the list again and replace it. Until then, everyone who bought or " +
          "enquired in the meantime is not being excluded, so the campaign is paying " +
          "to show the ad to people who already did the thing."
        : "Export the list again and replace it, so the campaign talks to the people " +
          "who are actually interested now rather than the ones who were then.",
      reversible: true,
      costIfWrong: "Nothing. Replacing a list with a newer version of itself.",
    });
  }

  return findings;
}

/** Whether every live use of this audience is as an exclusion. */
function isOnlyExcluded(snapshot: Snapshot, audienceId: string): boolean {
  let included = false;
  for (const adSet of snapshot.adSets) {
    if (adSet.effective_status !== "ACTIVE") continue;
    if ((adSet.targeting?.custom_audiences ?? []).some((a) => a.id === audienceId)) {
      included = true;
    }
  }
  return !included;
}

export const audienceChecks = [
  audienceIncludesCustomerArea,
  noExclusions,
  staleUploadedAudience,
];
