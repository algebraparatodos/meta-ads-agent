/**
 * The weekly list of what was agreed to and not done.
 *
 * Worth testing because every failure here is a silent one. A wrong
 * weekday means the message never goes out; an age that reads "since
 * today" for something three weeks old means it goes out and says the
 * opposite of the thing it exists to say.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { age, composeWorklist, type Waiting } from "../src/mail/worklist.ts";
import { replyAddress } from "../src/mail/compose.ts";
import { group } from "../src/queue/proposals.ts";
import { weekdayOf } from "../src/dates.ts";
import type { Config } from "../src/config.ts";
import type { Finding } from "../src/checks/types.ts";

const config = {
  brands: [
    {
      id: "gede",
      displayName: "Gede Studio",
      campaignPrefix: "GEDE",
      pixelId: "1",
      domain: null,
    },
  ],
  notify: {
    to: "him@example.com",
    from: "ads@example.com",
    replyMailbox: "ads",
    replyDomain: "example.com",
    approvers: [],
  },
} as unknown as Config;

const waiting = (over: Partial<Waiting["item"]> = {}): Waiting => ({
  item: {
    id: 1,
    code: "ADS-0001",
    title: "9 ads lose their headline in the feed",
    change: "Crop the artwork for the feed.",
    brandId: "gede",
    since: "2026-09-18",
    ...over,
  },
  done: "https://example.com/d/abc",
});

test("Monday is 1 and Sunday is 7", () => {
  assert.equal(weekdayOf("2026-09-21"), 1);
  assert.equal(weekdayOf("2026-09-20"), 7);
  assert.equal(weekdayOf("2026-09-19"), 6);
});

test("the age is the point, so it is said plainly", () => {
  assert.equal(age("2026-09-21", "2026-09-21"), "since today");
  assert.equal(age("2026-09-20", "2026-09-21"), "since yesterday");
  assert.equal(age("2026-09-18", "2026-09-21"), "for 3 days");
  assert.equal(age("2026-08-24", "2026-09-21"), "for 4 weeks");
  // A clock that disagrees with the database must not produce "for -2
  // days", which reads as a bug and makes the whole message suspect.
  assert.equal(age("2026-09-23", "2026-09-21"), "since today");
});

test("the subject carries the count and the oldest age", () => {
  const one = composeWorklist([waiting()], config, "2026-09-21");
  assert.match(one.subject, /1 thing/);
  assert.match(one.subject, /for 3 days/);

  const two = composeWorklist(
    [waiting(), waiting({ id: 2, code: "ADS-0113", since: "2026-09-21" })],
    config,
    "2026-09-21",
  );
  assert.match(two.subject, /2 things/);
  assert.match(two.subject, /the oldest waiting for 3 days/);
});

test("every line carries its own way off the list", () => {
  const email = composeWorklist(
    [waiting(), waiting({ id: 2, code: "ADS-0113" })],
    config,
    "2026-09-21",
  );
  assert.equal(email.html.split("https://example.com/d/abc").length - 1, 2);
  assert.match(email.text, /Done: https:\/\/example\.com\/d\/abc/);
  assert.match(email.html, /Gede Studio/, "which business it belongs to is on the line");
});

test("a reply to the list is not filed against one proposal", () => {
  const email = composeWorklist([waiting()], config, "2026-09-21");
  assert.equal(email.replyTo, "ads@example.com");
  assert.doesNotMatch(email.replyTo, /ads-0001/i);
});

test("the reply address is a mailbox somebody chose, with the code in it", () => {
  // The local part is configurable because it has to be an address that
  // exists. Pointed at a plain mailbox the plus part is ignored by the
  // mail server and the reply still arrives; pointed at nothing, every
  // reply bounces two days later and nobody is told.
  assert.equal(replyAddress("ADS-0113", "j-dev.es", "juani"), "juani+ads-0113@j-dev.es");
  assert.equal(replyAddress("ADS-0113", "ads.j-dev.es"), "ads+ads-0113@ads.j-dev.es");
});

test("a group names what it found, not what it would act on", () => {
  // Nine audiences that would all be added to the same ad set. The
  // reference has to be the ad set, because that is the object an action
  // touches, but listing it nine times tells the reader nothing.
  const findings: Finding[] = ["one", "two", "three"].map((name) => ({
    id: "audience_ready_to_include",
    severity: "notice",
    brandId: "gede",
    refType: "adset",
    refId: "adset-1",
    refName: "The same ad set",
    groupName: `Audience ${name}`,
    title: `"Audience ${name}" is ready`,
    groupTitle: "{n} audiences are ready and nothing is using them",
    observed: "Seen.",
    change: "Add it.",
    reversible: true,
  }));

  const [grouped] = group(findings);
  assert.match(grouped!.observed, /"Audience one", "Audience two", "Audience three"/);
  assert.doesNotMatch(grouped!.observed, /same ad set", "The same ad set/);
});
