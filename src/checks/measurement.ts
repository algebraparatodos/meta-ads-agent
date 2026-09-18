/**
 * The checks that ask whether the numbers can be believed at all.
 *
 * These run before anything about performance, because every one of
 * them breaks reporting without breaking delivery. The campaign keeps
 * running, the money keeps going out, Meta raises no error, and the only
 * thing that changes is that the report is wrong. An account can sell
 * well and report nothing, and the obvious reading of that report is to
 * turn off the thing that was working.
 *
 * Which pixel an ad's conversions actually reach is its own question and
 * lives in `pixel-routing.ts`, because Meta answers it through three
 * different fields and the reasoning does not fit next to anything else.
 */

import { brandOf, thresholdsFor, type Brand, type Config } from "../config.ts";
import type { Snapshot } from "../meta/snapshot.ts";
import type { Ad, AdSet } from "../meta/types.ts";
import { n } from "../meta/types.ts";
import { percent, type Finding } from "./types.ts";

/** Where an ad actually sends people, wherever the creative hides it. */
export function destination(ad: Ad): string | null {
  const link = ad.creative?.object_story_spec?.link_data;
  const url = link?.link ?? link?.child_attachments?.[0]?.link;
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function indexBy<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

function brandForAd(ad: Ad, snapshot: Snapshot, config: Config): Brand | null {
  const campaign = snapshot.campaigns.find((c) => c.id === ad.campaign_id);
  return campaign ? brandOf(campaign.name, config.brands) : null;
}

/**
 * `conversion_domain` is a different thing from the pixel, and it also
 * goes missing quietly.
 *
 * The pixel says which dataset the conversions belong to. This says
 * which domain is the destination, and it is what Meta uses for
 * aggregated event measurement, the path that attributes conversions
 * from an iPhone whose owner declined tracking. Without it the campaign
 * delivers, the pixel receives, no error appears, and a share of the
 * conversions simply stop being credited to the ad that produced them.
 */
export function missingConversionDomain(snapshot: Snapshot, config: Config): Finding[] {
  const adSets = indexBy(snapshot.adSets);
  const findings: Finding[] = [];

  for (const ad of snapshot.ads) {
    if (ad.effective_status !== "ACTIVE") continue;
    const adSet = ad.adset_id ? adSets.get(ad.adset_id) : undefined;
    if (adSet?.destination_type === "ON_AD") continue;

    const target = destination(ad);
    if (!target) continue;

    const current = ad.conversion_domain?.replace(/^www\./, "") ?? "";
    if (current === target) continue;

    const brand = brandForAd(ad, snapshot, config);
    const empty = current.length === 0;
    findings.push({
      id: empty ? "missing_conversion_domain" : "mismatched_conversion_domain",
      handling: "auto",
      severity: "urgent",
      brandId: brand?.id ?? null,
      refType: "ad",
      refId: ad.id,
      refName: ad.name,
      title: empty
        ? `"${ad.name}" has no conversion domain`
        : `"${ad.name}" declares ${current} but links to ${target}`,
      observed: empty
        ? `The ad sends people to ${target} and its conversion_domain is empty. ` +
          "Conversions from iOS users who declined tracking are not being " +
          "attributed to it, and nothing reports an error."
        : `The ad links to ${target} while conversion_domain says ${current}.`,
      change: `Set conversion_domain to ${target}.`,
      action: { type: "set_conversion_domain", adId: ad.id, domain: target },
      reversible: true,
      costIfWrong:
        "Nothing is spent. Editing a live ad sends it back for review for a " +
        "few hours, which pauses delivery briefly.",
    });
  }

  return findings;
}

/**
 * How much of what the pixel sees Meta can tie to a real person.
 *
 * Meta scores each dataset on how well it matches events to accounts.
 * With no personal data attached, all it has is a cookie, and in half of
 * browsers those no longer survive long enough to matter. This reads the
 * `had_pii` aggregation, which answers the question directly instead of
 * making anyone open the panel.
 */
export function poorEventMatching(snapshot: Snapshot, config: Config): Finding[] {
  const findings: Finding[] = [];

  for (const brand of config.brands) {
    const reading = snapshot.pixels[brand.pixelId];
    if (!reading || reading.matching.length === 0) continue;
    const thresholds = thresholdsFor(config, brand.id);

    let withData = 0;
    let withoutData = 0;
    for (const row of reading.matching) {
      const count = n(row.count ?? 0);
      if (row.value === "has_pii") withData += count;
      else if (row.value === "not_has_pii") withoutData += count;
    }

    const total = withData + withoutData;
    if (total < thresholds.minEventsForMatching) continue;

    const share = withoutData / total;
    if (share < thresholds.maxUnmatchedShare) continue;

    findings.push({
      id: "poor_event_matching",
      severity: "notice",
      brandId: brand.id,
      refType: "pixel",
      refId: brand.pixelId,
      refName: `${brand.displayName} pixel`,
      title: `${percent(share)} of ${brand.displayName} events carry no customer data`,
      observed:
        `Of ${total.toLocaleString("en-GB")} events in the window, ` +
        `${withoutData.toLocaleString("en-GB")} reached Meta with nothing to match ` +
        "on but a cookie. Those are the ones most likely to go uncredited.",
      change:
        "Attach hashed email, and phone where it is known, to the server side " +
        "events, and pass the plain values to fbq init in the browser so the " +
        "pixel hashes them itself. Hashing on both sides matches nothing.",
      reversible: true,
    });
  }

  return findings;
}

/**
 * A pixel whose own settings are working against it.
 *
 * All four of these are read from the pixel node and all four are one
 * switch each. They are worth checking because nothing surfaces them:
 * a pixel with advanced matching off looks identical to one with it on
 * until you compare the match rate months later.
 */
export function pixelSettings(snapshot: Snapshot, config: Config): Finding[] {
  const findings: Finding[] = [];

  for (const brand of config.brands) {
    const pixel = snapshot.pixels[brand.pixelId]?.node;
    if (!pixel) continue;

    const wrong: string[] = [];
    if (pixel.is_unavailable) wrong.push("Meta reports the dataset as unavailable");
    if (pixel.enable_automatic_matching === false) {
      wrong.push("automatic advanced matching is off");
    }
    if (
      pixel.first_party_cookie_status &&
      pixel.first_party_cookie_status !== "first_party_cookie_enabled"
    ) {
      wrong.push("the first party cookie is not enabled");
    }
    if (pixel.data_use_setting && pixel.data_use_setting !== "advertising_and_analytics") {
      wrong.push(`data use is set to ${pixel.data_use_setting}`);
    }
    if (wrong.length === 0) continue;

    findings.push({
      id: "pixel_settings",
      severity: "notice",
      brandId: brand.id,
      refType: "pixel",
      refId: brand.pixelId,
      refName: `${brand.displayName} pixel`,
      title: `The ${brand.displayName} pixel is losing matches to its own settings`,
      observed: `On this dataset, ${wrong.join(", ")}.`,
      change:
        "Fix them in Events Manager. Each is a switch, and each one costs " +
        "matches for as long as it stays wrong.",
      reversible: true,
    });
  }

  return findings;
}

/**
 * Custom conversions written as a rule that will expire.
 *
 * A rule cannot be edited after the fact. The API answers
 * `{"success": true}` to the attempt and changes nothing, so a
 * conversion is either right the first time or replaced. That makes the
 * ones written in the negative worth watching: "the URL does not contain
 * any of these other pages" is correct until a new page ships, and then
 * it silently swallows it.
 */
export function fragileConversions(snapshot: Snapshot, config: Config): Finding[] {
  const findings: Finding[] = [];

  for (const conversion of snapshot.conversions) {
    if (conversion.is_archived) continue;
    const rule = conversion.rule ?? "";

    // A name starting with a warning is the only defence the API leaves,
    // since the rule itself cannot be corrected. One still in use means
    // somebody is about to pick it from a dropdown.
    if (/^(NO USAR|DO NOT USE|BROKEN)/i.test(conversion.name)) {
      findings.push({
        id: "retired_conversion_still_live",
        severity: "notice",
        brandId: null,
        refType: "pixel",
        refId: conversion.id,
        refName: conversion.name,
        title: `"${conversion.name}" is still selectable`,
        groupTitle: "{n} retired conversions are still selectable",
        observed:
          "It is named as retired but is not archived, so it still appears in " +
          "the list when choosing what a campaign optimises for.",
        change:
          "Archive it in Events Manager. The API accepts the call and does " +
          "not archive anything, so this one is done by hand.",
        reversible: true,
      });
      continue;
    }

    if (!rule.includes("i_not_contains")) continue;

    findings.push({
      id: "negative_conversion_rule",
      handling: "watch",
      severity: "notice",
      brandId: null,
      refType: "pixel",
      refId: conversion.id,
      refName: conversion.name,
      title: `"${conversion.name}" is defined by what it excludes`,
      groupTitle: "{n} conversions are defined by what they exclude",
      observed:
        "Its rule works by listing the pages it is not, which is correct only " +
        "until the site gains another page. The rule cannot be edited later.",
      change:
        "Check it against the site's current pages whenever a new landing " +
        "ships. When it no longer fits, create a replacement and rename this " +
        "one, because the rule itself is immutable.",
      reversible: true,
    });
  }

  return findings;
}

export const measurementChecks = [
  missingConversionDomain,
  poorEventMatching,
  pixelSettings,
  fragileConversions,
];
