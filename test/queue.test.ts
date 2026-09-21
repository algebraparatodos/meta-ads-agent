/**
 * Grouping, ordering and identity.
 *
 * These decide what somebody actually reads in the morning, and all
 * three fail quietly when they are wrong: grouping too eagerly hides a
 * finding inside another one, ordering badly buries the expensive
 * problem under trivia, and an unstable fingerprint sends the same email
 * every day until it gets filtered.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { fingerprint, fromAnalyst, group, toProposals } from "../src/queue/proposals.ts";
import type { Finding } from "../src/checks/types.ts";
import { addDays, daysBetween, windowOf } from "../src/dates.ts";

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "some_check",
  severity: "notice",
  brandId: "a",
  refType: "ad",
  refId: "ad1",
  refName: "An ad",
  title: '"An ad" has a problem',
  observed: "Something was seen.",
  change: "Do the thing.",
  reversible: true,
  ...over,
});

test("two of a kind stay separate, three become one", () => {
  const two = group([
    finding({ refId: "1", refName: "One" }),
    finding({ refId: "2", refName: "Two" }),
  ]);
  assert.equal(two.length, 2, "at two, the detail is worth more than the tidiness");

  const three = group([
    finding({ refId: "1", refName: "One" }),
    finding({ refId: "2", refName: "Two" }),
    finding({ refId: "3", refName: "Three" }),
  ]);
  assert.equal(three.length, 1);
  assert.match(three[0]!.observed, /"One", "Two", "Three"/, "every name survives, not just a count");
  assert.equal(three[0]!.refId, "1,2,3", "the executor needs all the ids back");
});

test("a grouped title reads as English, not as a mail merge", () => {
  const grouped = group([
    finding({ refId: "1", groupTitle: "{n} ads lose their headline" }),
    finding({ refId: "2", groupTitle: "{n} ads lose their headline" }),
    finding({ refId: "3", groupTitle: "{n} ads lose their headline" }),
  ]);
  assert.equal(grouped[0]!.title, "3 ads lose their headline");

  // Without one, the fallback has to be clumsy but never wrong.
  const noTitle = group([finding({ refId: "1" }), finding({ refId: "2" }), finding({ refId: "3" })]);
  assert.equal(noTitle[0]!.title, '3 like this: "An ad" has a problem');
});

test("different checks and different brands never merge", () => {
  const mixed = group([
    finding({ refId: "1", id: "check_a" }),
    finding({ refId: "2", id: "check_a" }),
    finding({ refId: "3", id: "check_a" }),
    finding({ refId: "4", id: "check_a", brandId: "b" }),
    finding({ refId: "5", id: "check_b" }),
  ]);
  assert.equal(mixed.length, 3, "one group of three, plus the other brand, plus the other check");
});

test("a grouped proposal carries no executable action", async () => {
  const proposals = await toProposals(
    [1, 2, 3].map((n) =>
      finding({
        refId: String(n),
        action: { type: "pause_ad", adId: String(n) },
      }),
    ),
    "2026-09-18",
  );
  // An action shaped for one ad cannot be applied to three, and offering
  // it as one click would apply it to whichever ad happened to be first.
  assert.equal(proposals[0]!.action, null);
});

test("urgent outranks everything, and a group outranks a single", async () => {
  const proposals = await toProposals(
    [
      finding({ id: "quiet", refId: "q" }),
      finding({ id: "loud", refId: "u", severity: "urgent" }),
      ...[1, 2, 3, 4].map((n) => finding({ id: "many", refId: `m${n}` })),
    ],
    "2026-09-18",
  );

  assert.equal(proposals[0]!.kind, "loud", "every hour it stays true costs more");
  assert.equal(proposals[1]!.kind, "many", "four at once beats one");
  assert.equal(proposals[2]!.kind, "quiet");
});

test("the fingerprint tracks the thing, not the wording", async () => {
  const before = await fingerprint(["check", "brand", "ad", "ad1"]);
  const after = await fingerprint(["check", "brand", "ad", "ad1"]);
  assert.equal(before, after, "the same problem has the same identity tomorrow");

  const elsewhere = await fingerprint(["check", "brand", "ad", "ad2"]);
  assert.notEqual(before, elsewhere);

  // The separator has to be something that cannot occur inside a part,
  // or "a|b" and "a" + "|b" collide and one proposal silences another.
  const split = await fingerprint(["ab", "c"]);
  const other = await fingerprint(["a", "bc"]);
  assert.notEqual(split, other);
});

test("dates survive a daylight saving change", () => {
  // Europe moves its clocks on the last Sunday of October. Built at
  // midnight, adding a day here lands on the same date twice.
  assert.equal(addDays("2026-10-24", 1), "2026-10-25");
  assert.equal(addDays("2026-10-25", 1), "2026-10-26");
  assert.equal(addDays("2026-03-28", 1), "2026-03-29");
  assert.equal(addDays("2026-03-29", 1), "2026-03-30");

  assert.equal(addDays("2027-01-01", -1), "2026-12-31");
  assert.equal(daysBetween("2026-10-24", "2026-10-31"), 7);
});

test("a window of seven days includes both ends", () => {
  // Meta treats time_range as inclusive, so a seven day window asked for
  // as eight days of difference silently reports eight days.
  assert.deepEqual(windowOf("2026-09-17", 7), { since: "2026-09-11", until: "2026-09-17" });
  assert.equal(daysBetween("2026-09-11", "2026-09-17"), 6, "six steps, seven days");
});

/**
 * Partially fixing a group must not produce a second proposal.
 *
 * This is the failure the fingerprint change exists for: nine ads share
 * one problem, two get fixed, and the remaining seven hash differently
 * from the nine. The old proposal is still open and a second email
 * arrives the morning after doing the work, which reads as the agent
 * not noticing.
 */
test("a group keeps its identity when some of it is fixed", async () => {
  const nine = Array.from({ length: 9 }, (_, i) =>
    finding({ refId: `ad${i}`, refName: `Ad ${i}` }),
  );
  const seven = nine.slice(0, 7);

  const [before] = await toProposals(nine, "2026-01-01");
  const [after] = await toProposals(seven, "2026-01-02");

  assert.equal(before?.refName, "9 objects");
  assert.equal(after?.refName, "7 objects");
  assert.equal(
    before?.fingerprint,
    after?.fingerprint,
    "the same problem on the same brand is one proposal, whoever is in it today",
  );
});

test("a group and a single of the same check are not the same proposal", async () => {
  const [asGroup] = await toProposals(
    Array.from({ length: 3 }, (_, i) => finding({ refId: `ad${i}` })),
    "2026-01-01",
  );
  const [alone] = await toProposals([finding({ refId: "ad0" })], "2026-01-01");

  assert.notEqual(asGroup?.fingerprint, alone?.fingerprint);
});

test("the model's name for a brand is turned back into the brand", async () => {
  const brands = [
    { id: "gede", displayName: "Gede Studio", campaignPrefix: "GEDE", pixelId: "1", domain: null },
    { id: "ccn", displayName: "Ceramica con Nati", campaignPrefix: "CCN", pixelId: "2", domain: null },
  ];
  const judgement = {
    kind: "budget",
    ref_type: "adset" as const,
    ref_id: "1",
    ref_name: "An ad set",
    title: "t",
    observed: "o",
    hypothesis: "h",
    change: "c",
    confirms: { metric: "m", on: "adset", on_id: "1", direction: "up", threshold: 1, days: 7 },
    falsified_by: "f",
    cost_if_wrong: "c",
    reversible: true,
    confidence: "medium",
  };

  // The summary names brands the way a person does, so the model answers
  // with a display name one day and a campaign prefix the next.
  const [byName] = await fromAnalyst([{ ...judgement, brand_id: "Gede Studio" }], "2026-01-01", brands);
  const [byPrefix] = await fromAnalyst([{ ...judgement, brand_id: "GEDE" }], "2026-01-01", brands);
  const [byId] = await fromAnalyst([{ ...judgement, brand_id: "gede" }], "2026-01-01", brands);

  assert.equal(byName?.brandId, "gede");
  assert.equal(byPrefix?.brandId, "gede");
  assert.equal(byId?.brandId, "gede");
  assert.equal(
    byName?.fingerprint,
    byPrefix?.fingerprint,
    "otherwise the same judgement arrives again tomorrow under another spelling",
  );
  assert.equal(byName?.fingerprint, byId?.fingerprint);

  const [unknown] = await fromAnalyst([{ ...judgement, brand_id: "Some other shop" }], "2026-01-01", brands);
  assert.equal(unknown?.brandId, null, "a brand nobody configured is not a brand");
});
