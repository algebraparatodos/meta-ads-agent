/**
 * Where an ad's conversions actually end up.
 *
 * Split out from the other measurement checks because working it out is
 * harder than it looks, and getting it wrong in either direction is
 * expensive. Miss a real fault and a brand's sales are credited to the
 * other one. Raise a false one and somebody goes and "fixes" an ad that
 * was correct, which is worse, because now it is broken and it has been
 * signed off.
 *
 * Meta gives an ad its pixel through three different doors and only one
 * of them is visible on the ad itself:
 *
 *   1. `promoted_object.pixel_id` on the ad set, for a conversion
 *      campaign bidding straight on a pixel event.
 *   2. `promoted_object.custom_conversion_id` on the ad set, where the
 *      pixel is whichever one that custom conversion is defined on. The
 *      ad set never names the pixel, so it has to be looked up.
 *   3. `tracking_specs` on the ad itself, which is the only door open to
 *      a traffic campaign, because a traffic ad set will not accept a
 *      promoted object at all.
 *
 * An earlier version of this file only knew about door one, and it
 * would have reported four perfectly healthy sales ads as unmeasured.
 */

import { brandOf, type Brand, type Config } from "../config.ts";
import type { Snapshot } from "../meta/snapshot.ts";
import type { Ad, AdSet } from "../meta/types.ts";
import { conversionPixel } from "../meta/types.ts";
import type { Finding } from "./types.ts";

/** How an ad came to be measured against a pixel, or why it is not. */
export type Routing =
  | { via: "adset_pixel"; pixelId: string }
  | { via: "custom_conversion"; pixelId: string; conversionName: string }
  | { via: "custom_conversion"; pixelId: null; conversionName: string; conversionId: string }
  | { via: "ad_tracking"; pixelId: string }
  | { via: "lead_form" }
  | { via: "none" };

/** The pixel entries an ad carries on itself. */
export function trackedPixels(ad: Ad): string[] {
  const found: string[] = [];
  for (const spec of ad.tracking_specs ?? []) {
    const values = spec["fb_pixel"];
    if (Array.isArray(values)) found.push(...values);
  }
  return found;
}

/**
 * Works out which pixel an ad's conversions reach, checking all three
 * doors in the order Meta resolves them.
 */
export function routingOf(ad: Ad, adSet: AdSet | undefined, snapshot: Snapshot): Routing {
  // A lead form lives inside Facebook. There is no website event to
  // attribute, so there is no pixel that belongs on it and its absence
  // is not a fault.
  if (adSet?.destination_type === "ON_AD") return { via: "lead_form" };

  const direct = adSet?.promoted_object?.pixel_id;
  if (direct) return { via: "adset_pixel", pixelId: direct };

  const conversionId = adSet?.promoted_object?.custom_conversion_id;
  if (conversionId) {
    const conversion = snapshot.conversions.find((c) => c.id === conversionId);
    const pixelId = conversion ? conversionPixel(conversion) : null;
    if (pixelId) {
      return { via: "custom_conversion", pixelId, conversionName: conversion?.name ?? "" };
    }
    // The conversion exists but will not say which dataset it belongs
    // to, or it is not in the account listing at all. Either way this is
    // "cannot tell", which is a different answer from "no pixel" and
    // must not be reported as one.
    return {
      via: "custom_conversion",
      pixelId: null,
      conversionName: conversion?.name ?? "unknown conversion",
      conversionId,
    };
  }

  const own = trackedPixels(ad);
  if (own.length > 0 && own[0]) return { via: "ad_tracking", pixelId: own[0] };

  return { via: "none" };
}

function brandForAd(ad: Ad, snapshot: Snapshot, config: Config): Brand | null {
  const campaign = snapshot.campaigns.find((c) => c.id === ad.campaign_id);
  return campaign ? brandOf(campaign.name, config.brands) : null;
}

type Live = { ad: Ad; adSet: AdSet | undefined; routing: Routing; brand: Brand | null };

function liveAds(snapshot: Snapshot, config: Config): Live[] {
  const adSets = new Map(snapshot.adSets.map((a) => [a.id, a]));
  return snapshot.ads
    .filter((ad) => ad.effective_status === "ACTIVE")
    .map((ad) => {
      const adSet = ad.adset_id ? adSets.get(ad.adset_id) : undefined;
      return { ad, adSet, routing: routingOf(ad, adSet, snapshot), brand: brandForAd(ad, snapshot, config) };
    });
}

/**
 * A live ad whose conversions reach no pixel at all.
 *
 * This is the traffic campaign case. The ad set cannot carry a promoted
 * object, so the pixel has to be set on each ad by hand, and an ad
 * created through the API is born without it. Nothing reports the gap:
 * the campaign delivers, the pixel receives from everywhere else, and
 * the conversions land in the account's default dataset. On an account
 * with more than one pixel, that is not necessarily the right brand.
 */
export function unroutedAd(snapshot: Snapshot, config: Config): Finding[] {
  const findings: Finding[] = [];

  for (const { ad, adSet, routing, brand } of liveAds(snapshot, config)) {
    if (routing.via !== "none") continue;

    findings.push({
      id: "unrouted_ad",
      severity: "urgent",
      brandId: brand?.id ?? null,
      refType: "ad",
      refId: ad.id,
      refName: ad.name,
      title: `"${ad.name}" is running without a pixel attached`,
      groupTitle: "{n} ads are running without a pixel attached",
      observed:
        `It is active, its ad set ${adSet ? `"${adSet.name}" ` : ""}carries no ` +
        "promoted object, and the ad itself has no fb_pixel in tracking_specs. " +
        "Its conversions are being counted against the account's default " +
        "dataset rather than this brand's.",
      change: brand
        ? `Add ${brand.pixelId} (${brand.displayName}) to the ad's tracking_specs.`
        : "Add the pixel of whichever brand this campaign belongs to, once that is settled.",
      ...(brand
        ? { action: { type: "set_tracking_pixel" as const, adId: ad.id, pixelId: brand.pixelId } }
        : {}),
      reversible: true,
      costIfWrong: "Nothing is spent. The ad goes back for review for a few hours.",
    });
  }

  return findings;
}

/**
 * A live ad measured against the other brand's pixel.
 *
 * Harder to spot than no pixel at all, because everything looks healthy:
 * events arrive, dashboards move, audiences grow. They are just the
 * wrong brand's, and both brands end up bidding on a mixture.
 */
export function crossedPixel(snapshot: Snapshot, config: Config): Finding[] {
  const findings: Finding[] = [];

  for (const { ad, routing, brand } of liveAds(snapshot, config)) {
    if (!brand) continue;
    if (!("pixelId" in routing) || !routing.pixelId) continue;
    if (routing.pixelId === brand.pixelId) continue;

    // Only another brand of this account counts as crossed. A pixel we
    // do not recognise belongs to somebody else's business, and a
    // retired one is the check below, not this one.
    const owner = config.brands.find((b) => b.pixelId === routing.pixelId);
    if (!owner) continue;

    findings.push({
      id: "crossed_pixel",
      severity: "urgent",
      brandId: brand.id,
      refType: "ad",
      refId: ad.id,
      refName: ad.name,
      title: `"${ad.name}" reports to ${owner.displayName}`,
      observed:
        `The campaign belongs to ${brand.displayName} but the ad is measured ` +
        `against ${owner.displayName}'s pixel` +
        (routing.via === "custom_conversion"
          ? `, through the custom conversion "${routing.conversionName}"`
          : "") +
        ". Events are arriving, so nothing looks broken. They are landing on " +
        "the other business.",
      change:
        routing.via === "custom_conversion"
          ? `Point the ad set at a custom conversion defined on ${brand.pixelId}. ` +
            "A published ad set will not accept a new conversion, so this means " +
            "cloning it, and the clone starts learning from zero."
          : `Point tracking_specs at ${brand.pixelId} (${brand.displayName}).`,
      ...(routing.via === "ad_tracking"
        ? { action: { type: "set_tracking_pixel" as const, adId: ad.id, pixelId: brand.pixelId } }
        : {}),
      reversible: routing.via === "ad_tracking",
    });
  }

  return findings;
}

/**
 * A live ad still pointing at a pixel this account has retired.
 *
 * Not hypothetical. Pixels accumulate: a business changes its site, sets
 * up a new dataset, and the old one keeps receiving from pages nobody
 * updated. An ad cloned from an old one inherits the old pixel, and its
 * conversions go somewhere no live campaign can bid on.
 */
export function retiredPixelInUse(snapshot: Snapshot, config: Config): Finding[] {
  if (config.retiredPixels.length === 0) return [];
  const retired = new Map(config.retiredPixels.map((p) => [p.id, p.name]));
  const findings: Finding[] = [];

  for (const { ad, routing, brand } of liveAds(snapshot, config)) {
    if (!("pixelId" in routing) || !routing.pixelId) continue;
    const label = retired.get(routing.pixelId);
    if (!label) continue;

    findings.push({
      id: "retired_pixel_in_use",
      severity: "urgent",
      brandId: brand?.id ?? null,
      refType: "ad",
      refId: ad.id,
      refName: ad.name,
      title: `"${ad.name}" still reports to a retired pixel`,
      groupTitle: "{n} ads still report to a retired pixel",
      observed:
        `Its conversions go to ${routing.pixelId} (${label}), which this account ` +
        "stopped using. Nothing live can bid on what lands there, so as far as " +
        "every current campaign is concerned those conversions did not happen.",
      change: brand
        ? `Move it to ${brand.pixelId} (${brand.displayName}).`
        : "Move it to the pixel of the brand this campaign belongs to.",
      ...(brand && routing.via === "ad_tracking"
        ? { action: { type: "set_tracking_pixel" as const, adId: ad.id, pixelId: brand.pixelId } }
        : {}),
      reversible: routing.via === "ad_tracking",
    });
  }

  return findings;
}

/**
 * An ad set bidding on a custom conversion that will not say which
 * pixel it belongs to.
 *
 * Reported as its own thing rather than folded into "no pixel", because
 * the honest answer here is that we cannot tell, and the two call for
 * opposite actions. A missing pixel is fixed by adding one. This is
 * fixed by looking, and it might turn out there was nothing wrong.
 */
export function unresolvedConversion(snapshot: Snapshot, config: Config): Finding[] {
  const seen = new Set<string>();
  const findings: Finding[] = [];

  for (const { adSet, routing, brand } of liveAds(snapshot, config)) {
    if (routing.via !== "custom_conversion" || routing.pixelId !== null) continue;
    if (!adSet || seen.has(adSet.id)) continue;
    seen.add(adSet.id);

    findings.push({
      id: "unresolved_conversion",
      severity: "notice",
      brandId: brand?.id ?? null,
      refType: "adset",
      refId: adSet.id,
      refName: adSet.name,
      title: `Cannot tell which pixel "${adSet.name}" is measured on`,
      observed:
        `It bids on custom conversion ${routing.conversionId} ` +
        `("${routing.conversionName}"), and that conversion does not appear in ` +
        "the account listing with a dataset attached. Its numbers cannot be " +
        "attributed to a brand until that is resolved.",
      change:
        "Read the conversion directly with the data_sources field, which is " +
        "the only one that answers. If it belongs to the wrong brand, the ad " +
        "set has to be cloned, because a published one will not accept a new " +
        "conversion.",
      reversible: true,
    });
  }

  return findings;
}

export const routingChecks = [
  unroutedAd,
  crossedPixel,
  retiredPixelInUse,
  unresolvedConversion,
];
