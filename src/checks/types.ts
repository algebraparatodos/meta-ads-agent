/**
 * What a check produces.
 *
 * Checks are pure functions: a snapshot goes in, findings come out. They
 * do not call Meta, do not touch the database and do not send anything.
 * That is what makes it possible to argue about a threshold without
 * deploying, which is the part that actually gets argued about.
 *
 * None of these needs a language model. Every expensive mistake this
 * project was built to catch is deterministic: a field that is empty, a
 * pixel id that belongs to the other brand, a string holding a
 * replacement character. Sending that to a model would be slower, more
 * expensive and less reliable, and it would stop working on the day the
 * monthly budget runs out, which is the day you most want it working.
 */

import type { Snapshot } from "../meta/snapshot.ts";
import type { Config } from "../config.ts";

/**
 * How fast this needs a human.
 *
 * The difference is not how bad it is, it is how much every hour costs.
 * `urgent` means money is being lost or wasted right now. Everything
 * else waits for the daily email, because a watcher that shouts at
 * everything gets filtered into a folder and then it protects nothing.
 */
export type Severity = "urgent" | "notice";

export type RefType = "campaign" | "adset" | "ad" | "pixel" | "site";

/**
 * A change the executor knows how to make.
 *
 * Deliberately a closed list of shapes rather than free text. The
 * executor holds the token that can spend money, so it must never be in
 * the position of interpreting an instruction: it either recognises the
 * shape and knows how to both apply and re-read it, or it refuses.
 */
export type Action =
  | { type: "pause_ad"; adId: string }
  | { type: "pause_adset"; adSetId: string }
  | { type: "set_adset_budget"; adSetId: string; dailyBudgetMinor: number }
  | { type: "set_conversion_domain"; adId: string; domain: string }
  | { type: "set_tracking_pixel"; adId: string; pixelId: string }
  | { type: "set_adset_end"; adSetId: string; endTime: string };

export type Finding = {
  /** Stable across runs. Half of the fingerprint that stops repeats. */
  id: string;
  severity: Severity;
  brandId: string | null;
  refType: RefType;
  refId: string;
  refName: string;
  /** One line. It becomes the email subject, so it carries the figure. */
  title: string;
  /**
   * The title to use when several of these are sent as one, with `{n}`
   * standing in for how many.
   *
   * Needed because a title built around one object's name does not
   * survive being made plural by machine: "9 ads loses its headline" is
   * what you get, and it reads like a bug even when the finding is
   * right. Optional, and there is a plain fallback without it.
   */
  groupTitle?: string;
  /** What was seen, with the number that was seen. */
  observed: string;
  /** What to do about it, concretely enough to act on. */
  change: string;
  /** Present only when the executor can carry it out unaided. */
  action?: Action;
  reversible: boolean;
  /** What it costs if acting on this turns out to be wrong. */
  costIfWrong?: string;
};

export type Check = (snapshot: Snapshot, config: Config) => Finding[];

/** Formats money the way a person reads it, not the way Meta stores it. */
export function money(amount: number, currency: string): string {
  const figure = amount.toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === "EUR" ? `${figure} EUR` : `${figure} ${currency}`;
}

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
