/**
 * Counting results, which every threshold in the project rests on.
 *
 * Meta reports one conversion under several names and a brand can count
 * two different conversions, so both the naive sum and the naive
 * maximum are wrong, in opposite directions and both silently. Getting
 * this wrong does not raise anything: it reports an ad set as having no
 * results and proposes turning off something that works.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { countResults } from "../src/meta/types.ts";
import type { Insight } from "../src/meta/types.ts";

const row = (actions: [string, string][]): Insight =>
  ({ actions: actions.map(([action_type, value]) => ({ action_type, value })) }) as Insight;

test("one sale reported under three names is one sale", () => {
  const insight = row([
    ["purchase", "3"],
    ["offsite_conversion.fb_pixel_purchase", "3"],
    ["omni_purchase", "3"],
  ]);
  assert.equal(countResults(insight, ["purchase"]), 3, "summing these invents revenue");
});

test("two different events a brand counts are both counted", () => {
  const insight = row([
    ["purchase", "5"],
    ["offsite_conversion.fb_pixel_purchase", "5"],
    ["lead", "2"],
  ]);
  assert.equal(
    countResults(insight, ["purchase", "lead"]),
    7,
    "taking one maximum across different events throws the smaller one away",
  );
});

test("an event nobody asked about is not counted", () => {
  assert.equal(countResults(row([["landing_page_view", "40"]]), ["purchase"]), 0);
});
