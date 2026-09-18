/**
 * The regression test for the mistake this project already made once.
 *
 * The first version of the pixel check only knew that an ad set can
 * carry `promoted_object.pixel_id`. Aimed at a real account it reported
 * four healthy sales ads as unmeasured, because their ad set carried a
 * `custom_conversion_id` instead and Meta resolves the pixel from that.
 *
 * Nobody would have caught it by reading the code: it looks right, and
 * the account it was written against did not have that shape. So the
 * point of this file is not coverage, it is that the specific wrong
 * answer can never come back quietly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { routingOf, unroutedAd, crossedPixel, retiredPixelInUse } from "../src/checks/pixel-routing.ts";
import type { Snapshot } from "../src/meta/snapshot.ts";
import type { Ad, AdSet, CustomConversion } from "../src/meta/types.ts";
import type { Config } from "../src/config.ts";
import { DEFAULT_THRESHOLDS } from "../src/config.ts";

const PIXEL_A = "111111111111111";
const PIXEL_B = "222222222222222";
const PIXEL_OLD = "999999999999999";

const config: Config = {
  enabled: true,
  accountId: "act_1",
  timeZone: "UTC",
  currency: "EUR",
  brands: [
    { id: "a", displayName: "Brand A", campaignPrefix: "AAA", pixelId: PIXEL_A, domain: "a.example" },
    { id: "b", displayName: "Brand B", campaignPrefix: "BBB", pixelId: PIXEL_B, domain: "b.example" },
  ],
  retiredPixels: [{ id: PIXEL_OLD, name: "old one" }],
  customerAreas: [],
  thresholds: DEFAULT_THRESHOLDS,
  notify: { to: "", from: "", replyDomain: "", approvers: [] },
  budget: { dailyEur: 1, monthlyEur: 10 },
  maxProposalsPerDay: 3,
  proposalTtlDays: 7,
};

function snapshot(parts: {
  ads: Ad[];
  adSets: AdSet[];
  conversions?: CustomConversion[];
}): Snapshot {
  return {
    day: "2026-09-18",
    accountId: "act_1",
    currency: "EUR",
    timeZone: "UTC",
    account: { account_status: 1 },
    adsRecent: [],
    adsPrevious: [],
    adSetsRecent: [],
    campaigns: [{ id: "c1", name: "AAA · Something", effective_status: "ACTIVE" }],
    adSets: parts.adSets,
    ads: parts.ads,
    images: {},
    conversions: parts.conversions ?? [],
    audiences: [],
    pixels: {},
  };
}

const ad = (over: Partial<Ad> = {}): Ad => ({
  id: "ad1",
  name: "An ad",
  adset_id: "as1",
  campaign_id: "c1",
  effective_status: "ACTIVE",
  ...over,
});

const adSet = (over: Partial<AdSet> = {}): AdSet => ({
  id: "as1",
  name: "An ad set",
  campaign_id: "c1",
  effective_status: "ACTIVE",
  ...over,
});

test("an ad set bidding on a custom conversion is measured, not unmeasured", () => {
  // This is the exact shape that produced the false positive.
  const snap = snapshot({
    ads: [ad()],
    adSets: [adSet({ promoted_object: { custom_conversion_id: "cc1" } })],
    conversions: [
      {
        id: "cc1",
        name: "Brand A | Purchase",
        data_sources: [{ id: PIXEL_A, source_type: "PIXEL", name: "Pixel A" }],
      },
    ],
  });

  assert.deepEqual(routingOf(snap.ads[0]!, snap.adSets[0]!, snap), {
    via: "custom_conversion",
    pixelId: PIXEL_A,
    conversionName: "Brand A | Purchase",
  });
  assert.equal(unroutedAd(snap, config).length, 0, "must not be reported as unmeasured");
  assert.equal(crossedPixel(snap, config).length, 0, "and it is on the right brand");
});

test("a custom conversion on the other brand's pixel is a crossed wire", () => {
  const snap = snapshot({
    ads: [ad()],
    adSets: [adSet({ promoted_object: { custom_conversion_id: "cc1" } })],
    conversions: [
      {
        id: "cc1",
        name: "Brand B | Purchase",
        data_sources: [{ id: PIXEL_B, source_type: "PIXEL", name: "Pixel B" }],
      },
    ],
  });

  const found = crossedPixel(snap, config);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.severity, "urgent");
  // Not offered as a one-click fix: a published ad set will not accept a
  // different conversion, so this one needs a clone and a conversation.
  assert.equal(found[0]!.action, undefined);
  assert.equal(found[0]!.reversible, false);
});

test("a traffic ad with no pixel anywhere is unmeasured", () => {
  const snap = snapshot({
    ads: [ad()],
    adSets: [adSet({ optimization_goal: "LANDING_PAGE_VIEWS", destination_type: "WEBSITE" })],
  });

  assert.deepEqual(routingOf(snap.ads[0]!, snap.adSets[0]!, snap), { via: "none" });
  const found = unroutedAd(snap, config);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.severity, "urgent");
  assert.deepEqual(found[0]!.action, {
    type: "set_tracking_pixel",
    adId: "ad1",
    pixelId: PIXEL_A,
  });
});

test("a lead form ad has no pixel and that is correct", () => {
  const snap = snapshot({
    ads: [ad()],
    adSets: [adSet({ destination_type: "ON_AD", promoted_object: { page_id: "p1" } })],
  });

  assert.deepEqual(routingOf(snap.ads[0]!, snap.adSets[0]!, snap), { via: "lead_form" });
  assert.equal(unroutedAd(snap, config).length, 0, "there is no website event to measure");
});

test("a retired pixel in use is reported, an unknown one is left alone", () => {
  const retired = snapshot({
    ads: [ad({ tracking_specs: [{ "action.type": ["offsite_conversion"], fb_pixel: [PIXEL_OLD] }] })],
    adSets: [adSet()],
  });
  assert.equal(retiredPixelInUse(retired, config).length, 1);
  assert.equal(crossedPixel(retired, config).length, 0, "retired is its own finding, not a crossed one");

  const stranger = snapshot({
    ads: [ad({ tracking_specs: [{ "action.type": ["offsite_conversion"], fb_pixel: ["777"] }] })],
    adSets: [adSet()],
  });
  assert.equal(retiredPixelInUse(stranger, config).length, 0);
  assert.equal(crossedPixel(stranger, config).length, 0, "somebody else's pixel is not our problem");
});

test("a conversion that will not say which pixel it uses is 'cannot tell', not 'no pixel'", () => {
  const snap = snapshot({
    ads: [ad()],
    adSets: [adSet({ promoted_object: { custom_conversion_id: "missing" } })],
    conversions: [],
  });

  // The distinction matters: one is fixed by adding a pixel, the other
  // by going and looking, and it might turn out nothing was wrong.
  assert.equal(unroutedAd(snap, config).length, 0);
  const routing = routingOf(snap.ads[0]!, snap.adSets[0]!, snap);
  assert.equal(routing.via, "custom_conversion");
  assert.equal("pixelId" in routing ? routing.pixelId : "absent", null);
});

test("paused ads are not checked at all", () => {
  const snap = snapshot({
    ads: [ad({ effective_status: "PAUSED" })],
    adSets: [adSet({ optimization_goal: "LANDING_PAGE_VIEWS" })],
  });
  assert.equal(unroutedAd(snap, config).length, 0, "nothing is being spent, so there is nothing to fix");
});
