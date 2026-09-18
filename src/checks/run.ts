/**
 * Runs every check and hands back one ordered list.
 *
 * The order is what somebody reads first thing in the morning, so it is
 * not alphabetical and it is not the order the checks were written in.
 * Urgent before everything else, and within that, measurement before
 * performance: a performance number read off broken measurement is worse
 * than no number, because it looks like a reason to act.
 */

import type { Config } from "../config.ts";
import type { Snapshot } from "../meta/snapshot.ts";
import { audienceChecks } from "./audiences.ts";
import { creativeChecks } from "./creative.ts";
import { deliveryChecks, inReview } from "./delivery.ts";
import { measurementChecks } from "./measurement.ts";
import { routingChecks } from "./pixel-routing.ts";
import type { Check, Finding } from "./types.ts";

/**
 * In reading order.
 *
 * Routing first because it answers "can these numbers be trusted at
 * all", then the rest of measurement, then what the ad shows a person,
 * then who it is shown to, then what the account is doing with the
 * money.
 */
export const allChecks: Check[] = [
  ...routingChecks,
  ...measurementChecks,
  ...creativeChecks,
  ...audienceChecks,
  ...deliveryChecks,
];

/** Urgent first, then in the order the checks are declared above. */
function bySeverityThenOrder(findings: Finding[]): Finding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => {
      if (a.finding.severity !== b.finding.severity) {
        return a.finding.severity === "urgent" ? -1 : 1;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.finding);
}

/**
 * One check throwing must not cost the others.
 *
 * They are pure functions over data that came from someone else's API,
 * and a field that arrives as a shape nobody expected is a question of
 * when, not if. Losing one check's findings is a bad morning; losing all
 * of them because of one is a silent one.
 */
export function runChecks(snapshot: Snapshot, config: Config): Finding[] {
  const findings: Finding[] = [];

  for (const check of allChecks) {
    try {
      findings.push(...check(snapshot, config));
    } catch (err) {
      console.error(`[checks] ${check.name} threw:`, err);
    }
  }

  return bySeverityThenOrder(findings);
}

/** Context for the analyst, which is not the same thing as a finding. */
export function context(snapshot: Snapshot): { pendingReview: { id: string; name: string }[] } {
  return { pendingReview: inReview(snapshot) };
}
