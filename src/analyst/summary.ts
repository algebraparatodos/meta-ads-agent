/**
 * What the model is shown.
 *
 * Never the raw snapshot. Handing a language model a pile of JSON and
 * asking it to spot a pattern is asking it to do arithmetic, which is
 * the thing it is worst at and the thing a computer is best at. Every
 * number here is already computed; the model's job is to say what they
 * mean and what to do about it.
 *
 * It is also the whole cost. Input is priced per token, so what goes in
 * is the budget: this file aims for something a person could read in two
 * minutes, on the theory that if a person could not work with it, the
 * model has no better chance.
 */

import type { Config } from "../config.ts";
import { brandOf, thresholdsFor } from "../config.ts";
import type { Snapshot } from "../meta/snapshot.ts";
import type { AdSet, Insight, Targeting } from "../meta/types.ts";
import { countResults, n } from "../meta/types.ts";
import type { Finding } from "../checks/types.ts";

function money(value: number, currency: string): string {
  return `${value.toFixed(2)} ${currency}`;
}

/** An audience in one line, because that is how it gets compared. */
function describeTargeting(targeting: Targeting | undefined): string {
  if (!targeting) return "not stated";
  const bits: string[] = [];

  const geo = targeting.geo_locations;
  if (geo?.countries?.length) bits.push(geo.countries.join("/"));
  for (const city of geo?.cities ?? []) {
    bits.push(`${city.name}${city.radius ? ` +${city.radius}${city.distance_unit ?? "km"}` : ""}`);
  }

  const ages = `${targeting.age_min ?? "?"}-${targeting.age_max ?? "?"}`;
  const genders = targeting.genders?.length
    ? targeting.genders.map((g) => (g === 1 ? "men" : "women")).join("/")
    : "all";
  bits.push(`${ages} ${genders}`);

  const interests = [
    ...(targeting.interests ?? []),
    ...(targeting.flexible_spec ?? []).flatMap((spec) => spec.interests ?? []),
  ].map((i) => i.name);
  if (interests.length) bits.push(`interests: ${interests.slice(0, 8).join(", ")}`);

  const included = (targeting.custom_audiences ?? []).map((a) => a.name);
  if (included.length) bits.push(`audiences: ${included.slice(0, 6).join(", ")}`);

  const excluded = (targeting.excluded_custom_audiences ?? []).map((a) => a.name);
  bits.push(excluded.length ? `excluding: ${excluded.slice(0, 6).join(", ")}` : "excluding nobody");

  const places = [
    ...(targeting.publisher_platforms ?? []),
    ...(targeting.instagram_positions ?? []).map((p) => `ig:${p}`),
  ];
  if (places.length) bits.push(places.join(","));

  return bits.join(" · ");
}

/**
 * When an ad set runs, in words.
 *
 * A set that has not started, or that finished, produces exactly the
 * same empty numbers as one that is broken, and the difference is the
 * whole diagnosis.
 */
function describeSchedule(set: AdSet, today: string): string {
  const start = set.start_time?.slice(0, 10);
  const end = set.end_time?.slice(0, 10);

  if (start && start > today) return `NOT STARTED YET, begins ${start}`;
  if (end && end < today) return `FINISHED on ${end}`;
  const from = start ? `running since ${start}` : "running";
  return end ? `${from}, ends ${end}` : from;
}

/**
 * Whether there is enough of anything here to draw a conclusion from.
 *
 * Fifty events a week is Meta's own threshold for an ad set to stop
 * guessing, and it is a reasonable floor for a person too. Below it,
 * comparing two costs per result is comparing two coin flips, and the
 * model will happily do exactly that unless told not to.
 */
function judgeVolume(row: Insight, resultActions: string[]): string | null {
  const results = countResults(row, resultActions);
  const clicks = n(row.inline_link_clicks);

  if (results >= 50) return null;
  if (results === 0 && clicks < 50) {
    return "VOLUME: too little of anything here to conclude much. Say so rather than reading it.";
  }
  return (
    `VOLUME: only ${results} results in the window. Differences in cost per result ` +
    "between ads at this volume are mostly chance. Do not propose a change that " +
    "rests on one being cheaper than another unless the gap is very large, and say " +
    "how long it would take to know."
  );
}

/** The performance line for one row, with the arithmetic already done. */
function performance(row: Insight, config: Config, resultActions: string[]): string {
  const spend = n(row.spend);
  const results = countResults(row, resultActions);
  const views = countResults(row, ["landing_page_view"]);
  const checkouts = countResults(row, ["initiate_checkout"]);

  const parts = [
    money(spend, config.currency),
    `${n(row.impressions).toLocaleString("en-GB")} impressions`,
    `reach ${n(row.reach).toLocaleString("en-GB")}`,
    `freq ${n(row.frequency).toFixed(2)}`,
    `CTR ${n(row.ctr).toFixed(2)}%`,
    `CPM ${n(row.cpm).toFixed(2)}`,
    `${n(row.inline_link_clicks)} link clicks`,
  ];
  if (views) parts.push(`${views} page views`);
  if (checkouts) parts.push(`${checkouts} checkouts started`);
  parts.push(`${results} results`);
  if (results > 0) parts.push(`${money(spend / results, config.currency)}/result`);
  else if (spend > 0) parts.push("NO results");

  return parts.join(", ");
}

/** Only what changed enough to be worth a sentence. */
function movement(now: Insight | undefined, before: Insight | undefined): string {
  if (!now || !before) return "";
  const parts: string[] = [];
  const pairs: [string, number, number][] = [
    ["CTR", n(before.ctr), n(now.ctr)],
    ["CPM", n(before.cpm), n(now.cpm)],
    ["spend", n(before.spend), n(now.spend)],
  ];
  for (const [label, was, is] of pairs) {
    if (was <= 0) continue;
    const change = (is - was) / was;
    if (Math.abs(change) < 0.2) continue;
    parts.push(`${label} ${change > 0 ? "up" : "down"} ${Math.abs(Math.round(change * 100))}%`);
  }
  if (parts.length === 0) return "";

  // A campaign that started last week shows enormous percentage growth
  // against a week when it barely ran, and that is not a signal about
  // anything. Said here rather than left to be worked out: the first
  // version of this summary produced a proposal to pause the best
  // performing ad in the account because its spend was "up 1985%".
  const spendBefore = n(before.spend);
  const ramping = spendBefore > 0 && n(now.spend) / spendBefore > 3;
  const caveat = ramping
    ? " — it barely ran the week before, so these percentages are a ramp-up, not a change in behaviour"
    : "";

  return ` [vs the week before: ${parts.join(", ")}${caveat}]`;
}

export type SummaryInput = {
  snapshot: Snapshot;
  config: Config;
  findings: Finding[];
  /** Ads Meta is still reviewing: context, so a quiet day is not read as fatigue. */
  pendingReview: { id: string; name: string }[];
  /** What was proposed before, with what came of it. */
  history: { code: string; title: string; state: string; comment: string | null }[];
  /** What the account's own history says normal looks like, if known. */
  baseline: string | null;
};

export function summarise(input: SummaryInput): string {
  const { snapshot, config, findings } = input;
  const out: string[] = [];

  out.push(`# Account ${snapshot.accountId}, ${snapshot.day} (${snapshot.timeZone})`);
  out.push(`Currency ${snapshot.currency}. Figures cover the last 7 closed days.`);
  out.push("");

  const adsByAdSet = new Map<string, Insight[]>();
  for (const row of snapshot.adsRecent) {
    if (!row.adset_id) continue;
    const list = adsByAdSet.get(row.adset_id) ?? [];
    list.push(row);
    adsByAdSet.set(row.adset_id, list);
  }
  const previousByAd = new Map(
    snapshot.adsPrevious.filter((r) => r.ad_id).map((r) => [r.ad_id!, r]),
  );
  const adSetRows = new Map(
    snapshot.adSetsRecent.filter((r) => r.adset_id).map((r) => [r.adset_id!, r]),
  );

  for (const campaign of snapshot.campaigns) {
    if (campaign.effective_status !== "ACTIVE") continue;
    const brand = brandOf(campaign.name, config.brands);
    const resultActions = thresholdsFor(config, brand?.id ?? null).resultActions;

    out.push(`## ${campaign.name}`);
    out.push(
      `brand: ${brand?.displayName ?? "UNKNOWN"} · objective: ${campaign.objective ?? "?"} · ` +
        `counting as a result: ${resultActions.join(", ")}`,
    );

    const sets: AdSet[] = snapshot.adSets.filter(
      (s) => s.campaign_id === campaign.id && s.effective_status === "ACTIVE",
    );

    for (const set of sets) {
      // Dates, because without them a set scheduled for next month looks
      // exactly like a broken one. The model proposed raising the budget
      // of an ad set that had not started yet, and it was right to from
      // what it could see: the summary had not told it.
      const schedule = describeSchedule(set, snapshot.day);
      const budget = set.daily_budget
        ? `${money(n(set.daily_budget) / 100, config.currency)}/day`
        : set.lifetime_budget
          ? `${money(n(set.lifetime_budget) / 100, config.currency)} lifetime`
          : "budget on the campaign";

      out.push("");
      out.push(`### ${set.name}`);
      out.push(
        `optimising for ${set.optimization_goal ?? "?"} · ${budget} · ${schedule} · ` +
          `${describeTargeting(set.targeting)}`,
      );

      const setRow = adSetRows.get(set.id);
      if (setRow) {
        out.push(`ad set totals: ${performance(setRow, config, resultActions)}`);
        // Said out loud rather than left to be inferred. Two results are
        // two results whether they cost 0.49 or 3.06 each, and the
        // difference between them is not yet a fact about the account.
        const enough = judgeVolume(setRow, resultActions);
        if (enough) out.push(enough);
      } else {
        out.push(
          "ad set totals: nothing delivered in this window. Check the dates above " +
            "before treating that as a fault.",
        );
      }

      const ads = (adsByAdSet.get(set.id) ?? []).sort((a, b) => n(b.spend) - n(a.spend));
      const totalSpend = ads.reduce((sum, row) => sum + n(row.spend), 0);

      for (const row of ads) {
        const share = totalSpend > 0 ? Math.round((n(row.spend) / totalSpend) * 100) : 0;
        out.push(
          `- ${row.ad_name} (${share}% of the set): ` +
            performance(row, config, resultActions) +
            movement(row, previousByAd.get(row.ad_id ?? "")),
        );
        const creative = snapshot.ads.find((a) => a.id === row.ad_id)?.creative;
        const copy = [creative?.body, creative?.object_story_spec?.link_data?.message]
          .filter((t): t is string => Boolean(t))
          .join(" / ");
        if (copy) out.push(`    copy: ${copy.replace(/\s+/g, " ").slice(0, 300)}`);
      }
    }
    out.push("");
  }

  // What audiences actually exist, with their sizes. Without this the
  // model proposes building an audience that already exists and is
  // empty, which reads as a sensible idea and cannot be carried out.
  const usable = snapshot.audiences
    .filter((a) => (a.approximate_count_lower_bound ?? 0) > 100)
    .sort((a, b) => (b.approximate_count_lower_bound ?? 0) - (a.approximate_count_lower_bound ?? 0));
  const empty = snapshot.audiences.length - usable.length;

  if (snapshot.audiences.length > 0) {
    out.push("## Audiences that exist on this account");
    if (usable.length === 0) {
      out.push(
        `All ${snapshot.audiences.length} of them are effectively empty (under a ` +
          "hundred people). Do not propose anything that depends on retargeting or " +
          "on a lookalike built from them: there is nobody in them to target or to " +
          "model from. Building the audience up is itself the proposal worth making.",
      );
    } else {
      for (const audience of usable.slice(0, 15)) {
        out.push(
          `- ${audience.name} (${audience.subtype ?? "?"}): about ` +
            `${(audience.approximate_count_lower_bound ?? 0).toLocaleString("en-GB")} people`,
        );
      }
      if (empty > 0) {
        out.push(
          `And ${empty} more that are effectively empty. Anything not listed here ` +
            "either does not exist or has nobody in it.",
        );
      }
    }
    out.push("");
  }

  if (input.pendingReview.length > 0) {
    out.push("## Still in review by Meta");
    out.push(
      "These were changed recently and are not delivering fully yet, which " +
        "is the usual reason for an unexpectedly quiet day:",
    );
    for (const ad of input.pendingReview) out.push(`- ${ad.name}`);
    out.push("");
  }

  if (findings.length > 0) {
    out.push("## Already found and already queued, do not propose these again");
    out.push(
      "Each line says what kind of object it is about. They are not " +
        "interchangeable: a rule on a custom conversion and a rule on an " +
        "audience are different things, and treating a finding about one as " +
        "evidence about the other produces a confident wrong answer.",
    );
    for (const finding of findings) {
      out.push(`- ${finding.refType} "${finding.refName}": ${finding.title} [${finding.id}]`);
    }
    out.push("");
  }

  if (input.history.length > 0) {
    out.push("## What was proposed before");
    for (const item of input.history) {
      out.push(
        `- ${item.code} (${item.state}): ${item.title}` +
          (item.comment ? ` — they said: "${item.comment}"` : ""),
      );
    }
    out.push("");
  }

  if (input.baseline) {
    out.push("## What this account's own history says normal looks like");
    out.push(input.baseline);
    out.push("");
  }

  return out.join("\n");
}
