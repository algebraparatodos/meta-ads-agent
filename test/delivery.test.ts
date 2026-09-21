/**
 * The urgent check, and the two ways it used to be wrong about who it
 * was talking about.
 *
 * "This is costing money right now" is the only thing here that
 * interrupts somebody's morning, so it has to be true. An urgent alert
 * about an ad set that was turned off last Tuesday is not a small
 * inaccuracy: it is what teaches the reader that urgent means nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { spendingWithoutResults, nonStandardAttribution } from "../src/checks/delivery.ts";
import type { Snapshot } from "../src/meta/snapshot.ts";
import type { AdSet, Insight } from "../src/meta/types.ts";
import { DEFAULT_THRESHOLDS, type Config } from "../src/config.ts";

const config: Config = {
  enabled: true,
  accountId: "act_1",
  timeZone: "UTC",
  currency: "EUR",
  brands: [
    { id: "a", displayName: "Brand A", campaignPrefix: "AAA", pixelId: "1", domain: null },
  ],
  retiredPixels: [],
  customerAreas: [],
  thresholds: DEFAULT_THRESHOLDS,
  notify: { to: "", from: "", replyMailbox: "ads", replyDomain: "", approvers: [] },
  budget: { dailyEur: 1, monthlyEur: 10 },
  maxProposalsPerDay: 3,
  proposalTtlDays: 7,
  worklistWeekday: 1,
};

const burning: Insight = {
  adset_id: "as1",
  adset_name: "Burning money",
  campaign_name: "AAA · Something",
  spend: "60",
  impressions: "20000",
  inline_link_clicks: "120",
  actions: [],
};

function snapshot(adSets: AdSet[], adSetsRecent: Insight[]): Snapshot {
  return {
    day: "2026-09-18",
    accountId: "act_1",
    currency: "EUR",
    timeZone: "UTC",
    account: { account_status: 1 },
    adsRecent: [],
    adsPrevious: [],
    adSetsRecent,
    campaigns: [{ id: "c1", name: "AAA · Something", effective_status: "ACTIVE" }],
    adSets,
    ads: [],
    images: {},
    conversions: [],
    audiences: [],
    pixels: {},
  };
}

test("an ad set burning money with no results is urgent", () => {
  const found = spendingWithoutResults(
    snapshot([{ id: "as1", name: "Burning money", campaign_id: "c1", effective_status: "ACTIVE" }], [burning]),
    config,
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]?.severity, "urgent");
});

test("an ad set already paused is not urgent, whatever it spent in the window", () => {
  // A seven day window keeps reporting what was spent before somebody
  // turned it off, so this fired every morning for a week after the
  // problem had been dealt with.
  const found = spendingWithoutResults(
    snapshot([{ id: "as1", name: "Burning money", campaign_id: "c1", effective_status: "PAUSED" }], [burning]),
    config,
  );
  assert.deepEqual(found, []);
});

test("attribution findings carry the brand, which lives on the campaign name", () => {
  const found = nonStandardAttribution(
    snapshot(
      [
        {
          id: "as1",
          // Deliberately no brand prefix here: the convention puts it on
          // the campaign, and reading it off the ad set answered null.
          name: "Retargeting 18-65",
          campaign_id: "c1",
          effective_status: "ACTIVE",
          attribution_spec: [{ event_type: "CLICK_THROUGH", window_days: 1 }],
        },
      ],
      [],
    ),
    config,
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]?.brandId, "a");
});
