/**
 * Watching the audiences that maintain themselves.
 *
 * Separate from `audiences.ts`, which asks whether an audience contains
 * the right people. These two ask a different question: whether anybody
 * is using it, and whether it is filling at all.
 *
 * Both close gaps that are invisible precisely because nothing happens.
 * A retargeting audience takes weeks to fill, and nothing announces the
 * week it becomes usable, so unless somebody happens to look on the
 * right day it sits there full and idle while the campaign it was built
 * for runs without it. And an audience that never fills looks identical
 * to one that is simply new, for as long as anyone cares to wait.
 */

import { brandOf, thresholdsFor, type Config } from "../config.ts";
import type { Snapshot } from "../meta/snapshot.ts";
import { audiencePurpose, isServable, type AdSet, type CustomAudience } from "../meta/types.ts";
import type { Finding } from "./types.ts";

/** Every audience a live ad set names, included or excluded. */
function inUse(snapshot: Snapshot): Set<string> {
  const used = new Set<string>();
  for (const adSet of snapshot.adSets) {
    if (adSet.effective_status !== "ACTIVE") continue;
    for (const a of adSet.targeting?.custom_audiences ?? []) used.add(a.id);
    for (const a of adSet.targeting?.excluded_custom_audiences ?? []) used.add(a.id);
  }
  return used;
}

/** The pixel an audience's rule is built on, if it names one. */
function pixelOf(audience: CustomAudience): string | null {
  const rule =
    typeof audience.rule === "string" ? audience.rule : JSON.stringify(audience.rule ?? "");
  const found = /"id"\s*:\s*"?(\d{10,})"?/.exec(rule);
  return found?.[1] ?? null;
}

function brandOfAdSet(set: AdSet, snapshot: Snapshot, config: Config): string | null {
  const campaign = snapshot.campaigns.find((c) => c.id === set.campaign_id);
  return campaign ? (brandOf(campaign.name, config.brands)?.id ?? null) : null;
}

/**
 * Which live ad set to suggest an audience for.
 *
 * Deliberately picks one, and only from the same brand. Suggesting the
 * same audience for four ad sets turns one decision into four, and an
 * audience built on one brand's pixel has no business narrowing the
 * other brand's campaign.
 *
 * For a list of buyers it only considers campaigns that are chasing
 * somebody new. A campaign built to reach existing customers should not
 * be told to exclude them.
 */
function pickAdSet(
  snapshot: Snapshot,
  config: Config,
  audience: CustomAudience,
  purpose: "buyers" | "interested",
): AdSet | undefined {
  const pixel = pixelOf(audience);
  const brand = config.brands.find((b) => b.pixelId === pixel);

  return snapshot.adSets.find((set) => {
    if (set.effective_status !== "ACTIVE") return false;
    const campaign = snapshot.campaigns.find((c) => c.id === set.campaign_id);
    if (!campaign) return false;
    if (brand && brandOf(campaign.name, config.brands)?.id !== brand.id) return false;
    if (purpose === "buyers") {
      return ["OUTCOME_SALES", "OUTCOME_LEADS", "OUTCOME_TRAFFIC"].includes(
        campaign.objective ?? "",
      );
    }
    return true;
  });
}

/**
 * An audience Meta says it can serve, that nothing is using.
 *
 * What to do with it is read from its rule rather than its name, because
 * names are a convention and conventions drift, while the rule is what
 * actually decides who is inside. A list of buyers is something to
 * subtract from a campaign looking for new customers; a list of people
 * who looked and did not buy is the warmest thing the account has.
 *
 * Meta's own `delivery_status` decides readiness rather than a size
 * threshold invented here. Meta knows its own minimum, changes it
 * without telling anyone, and accounts for things a headcount does not.
 */
export function audienceReadyAndUnused(snapshot: Snapshot, config: Config): Finding[] {
  const used = inUse(snapshot);
  const findings: Finding[] = [];

  for (const audience of snapshot.audiences) {
    if (audience.subtype !== "WEBSITE") continue;
    if (used.has(audience.id)) continue;
    if (!isServable(audience)) continue;

    const purpose = audiencePurpose(audience);
    if (purpose === "unclear") continue;

    const target = pickAdSet(snapshot, config, audience, purpose);
    if (!target) continue;

    const size = (audience.approximate_count_lower_bound ?? 0).toLocaleString("en-GB");
    const excluding = purpose === "buyers";

    findings.push({
      id: excluding ? "audience_ready_to_exclude" : "audience_ready_to_include",
      severity: "notice",
      // Audience and exclusions are editable on a published ad set and
      // do not restart its learning phase, unlike the optimisation
      // event. That is what makes this safe to apply unattended.
      handling: "auto",
      brandId: brandOfAdSet(target, snapshot, config),
      refType: "adset",
      refId: target.id,
      refName: target.name,
      title: excluding
        ? `"${target.name}" is still paying to reach people who already bought`
        : `"${audience.name}" is ready to advertise to, and nothing is using it`,
      groupTitle: "{n} audiences are ready and nothing is using them",
      observed: excluding
        ? `"${audience.name}" holds about ${size} people who already bought, Meta says ` +
          `it can serve it, and no live ad set excludes it. "${target.name}" is looking ` +
          "for new customers, so part of its budget goes to people who already did the " +
          "thing it is paying for."
        : `"${audience.name}" holds about ${size} people who looked at that product and ` +
          "did not buy. Meta says it can be served now and nothing is targeting it. It " +
          "is the warmest audience this account has for that product, sitting idle.",
      change: excluding
        ? `Exclude "${audience.name}" from "${target.name}".`
        : `Add "${audience.name}" to "${target.name}", or give it an ad set of its own.`,
      action: excluding
        ? {
            type: "exclude_audience",
            adSetId: target.id,
            audienceId: audience.id,
            audienceName: audience.name,
          }
        : {
            type: "include_audience",
            adSetId: target.id,
            audienceId: audience.id,
            audienceName: audience.name,
          },
      reversible: true,
      costIfWrong: excluding
        ? "A smaller audience. If that campaign was meant for existing customers this is " +
          "the wrong change, and it is one click to undo."
        : "Delivery moves towards a warmer, smaller audience, which usually costs more " +
          "per thousand and converts better. One click to undo.",
    });
  }

  return findings;
}

/**
 * A website audience that has been around for weeks and is still empty.
 *
 * This is not a small audience. An empty one, weeks after it was built,
 * means the event it waits for is not arriving: the pixel does not fire
 * on that page, or it fires without the product attached, or the rule
 * names something that never existed.
 *
 * Meta displays it exactly like an audience that is merely new, so left
 * alone it stays empty forever and the retargeting it was built for
 * silently never happens. Worth saying out loud once.
 */
export function audienceNeverFilled(snapshot: Snapshot, config: Config): Finding[] {
  const limit = thresholdsFor(config, null).emptyAudienceDays;
  const now = Date.now() / 1000;
  const findings: Finding[] = [];

  for (const audience of snapshot.audiences) {
    if (audience.subtype !== "WEBSITE") continue;
    if ((audience.approximate_count_lower_bound ?? 0) > 100) continue;

    const created = audience.time_created;
    if (!created) continue;
    const days = Math.floor((now - created) / 86400);
    if (days < limit) continue;

    findings.push({
      id: "audience_never_filled",
      severity: "notice",
      handling: "work",
      brandId: null,
      refType: "site",
      refId: audience.id,
      refName: audience.name,
      title: `"${audience.name}" has been empty for ${days} days`,
      groupTitle: "{n} website audiences have been empty since they were created",
      observed:
        `It was created ${days} days ago and still has nobody in it. A website audience ` +
        "that stays empty is usually not a small audience: it is an event that never " +
        "arrives, because the pixel does not fire on that page, or fires without the " +
        "product attached, or the rule names something that does not exist.",
      change:
        "Check in Events Manager whether the event its rule names is arriving at all, " +
        "and whether it carries the product in content_ids. If the rule is wrong, build " +
        "a replacement: an audience does not start filling retroactively.",
      reversible: true,
    });
  }

  return findings;
}

export const readinessChecks = [audienceReadyAndUnused, audienceNeverFilled];
