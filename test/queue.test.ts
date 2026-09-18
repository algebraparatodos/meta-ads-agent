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

import { fingerprint, group, toProposals } from "../src/queue/proposals.ts";
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
