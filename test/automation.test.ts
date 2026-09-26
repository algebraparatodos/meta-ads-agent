/**
 * Changes Meta makes on its own, and the two states they leave behind.
 *
 * The cases are the real ones from this account: an ad set opened to
 * every placement overnight, and two carousels switched to "carousel to
 * video". The line that matters most is the one about actor `0`: Meta's
 * review signs as Meta too, and an alert every time an ad is approved is
 * an alert nobody reads.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  automaticPlacements, creativeEnhancements, isAutomaticAdjustment, metaChangedOnItsOwn,
} from "../src/checks/automation.ts";
import type { Snapshot } from "../src/meta/snapshot.ts";
import type { Activity, Ad, AdSet } from "../src/meta/types.ts";
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

function snapshot(parts: { adSets?: AdSet[]; ads?: Ad[]; activities?: Activity[] }): Snapshot {
  return {
    day: "2026-09-26",
    accountId: "act_1",
    currency: "EUR",
    timeZone: "UTC",
    account: { account_status: 1 },
    adsRecent: [],
    adsPrevious: [],
    adSetsRecent: [],
    campaigns: [{ id: "c1", name: "AAA · Sales", effective_status: "ACTIVE" }],
    adSets: parts.adSets ?? [],
    ads: parts.ads ?? [],
    images: {},
    conversions: [],
    audiences: [],
    ...(parts.activities ? { activities: parts.activities } : {}),
    pixels: {},
  };
}

const opened: Activity = {
  event_time: "2026-09-25T22:26:44+0000",
  event_type: "update_ad_set_target_spec",
  translated_event_type: "Ad set targeting updated",
  actor_id: "1051435468209173",
  actor_name: "Meta",
  object_id: "as1",
  object_name: "Instagram only",
  object_type: "CAMPAIGN",
};

const running: AdSet = {
  id: "as1",
  name: "Instagram only",
  campaign_id: "c1",
  effective_status: "ACTIVE",
  targeting: { publisher_platforms: ["instagram"], instagram_positions: ["stream", "story", "reels"] },
};

test("a targeting change signed by Meta with a real id is an automatic adjustment", () => {
  assert.equal(isAutomaticAdjustment(opened), true);
});

test("Meta's review, which signs as actor 0, is not", () => {
  assert.equal(isAutomaticAdjustment({ ...opened, actor_id: "0", event_type: "update_ad_run_status" }), false);
  assert.equal(isAutomaticAdjustment({ ...opened, actor_id: "0" }), false);
});

test("a change made by a person or by this agent is not", () => {
  assert.equal(isAutomaticAdjustment({ ...opened, actor_name: "Claude-ads", actor_id: "122095479483461373" }), false);
});

test("the ads going back to review after the change do not count as more changes", () => {
  assert.equal(isAutomaticAdjustment({ ...opened, event_type: "update_ad_set_run_status" }), false);
});

test("Meta changing a running ad set is urgent, and one finding per object", () => {
  const found = metaChangedOnItsOwn(
    snapshot({
      adSets: [running],
      activities: [opened, { ...opened, event_type: "update_ad_set_run_status" }, { ...opened }],
    }),
    config,
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]?.severity, "urgent");
  assert.equal(found[0]?.refType, "adset");
  assert.equal(found[0]?.brandId, "a");
});

test("Meta changing something that is not running is only a notice", () => {
  const found = metaChangedOnItsOwn(snapshot({ adSets: [], activities: [opened] }), config);
  assert.equal(found[0]?.severity, "notice");
});

test("a snapshot stored before the activity log was read says nothing", () => {
  assert.deepEqual(metaChangedOnItsOwn(snapshot({ adSets: [running] }), config), []);
});

test("a running ad set that declares no placement is on automatic placements", () => {
  const automatic = { ...running, targeting: { age_min: 25 } };
  assert.equal(automaticPlacements(snapshot({ adSets: [automatic] }), config).length, 1);
  assert.equal(automaticPlacements(snapshot({ adSets: [running] }), config).length, 0);
});

test("a paused ad set on automatic placements is left alone", () => {
  const paused = { ...running, effective_status: "PAUSED", targeting: {} };
  assert.equal(automaticPlacements(snapshot({ adSets: [paused] }), config).length, 0);
});

test("a running ad with carousel to video switched on is reported, naming what is on", () => {
  const ad: Ad = {
    id: "ad1",
    name: "04 Carousel",
    campaign_id: "c1",
    effective_status: "ACTIVE",
    creative: {
      id: "cr1",
      degrees_of_freedom_spec: {
        creative_features_spec: {
          carousel_to_video: { enroll_status: "OPT_IN" },
          video_filtering: { enroll_status: "OPT_IN" },
          image_touchups: { enroll_status: "OPT_OUT" },
        },
      },
    },
  };
  const found = creativeEnhancements(snapshot({ ads: [ad] }), config);
  assert.equal(found.length, 1);
  assert.match(found[0]!.observed, /carousel_to_video, video_filtering/);
});

test("a creative with every enhancement off says nothing", () => {
  const ad: Ad = {
    id: "ad1",
    name: "Clean",
    effective_status: "ACTIVE",
    creative: {
      id: "cr1",
      degrees_of_freedom_spec: { creative_features_spec: { carousel_to_video: { enroll_status: "OPT_OUT" } } },
    },
  };
  assert.equal(creativeEnhancements(snapshot({ ads: [ad] }), config).length, 0);
});
