/**
 * Dates, in the ad account's own timezone.
 *
 * This is not pedantry. Meta cuts its reporting days in the account's
 * timezone, so "the last three days" asked for with another calendar
 * silently returns a different range than the one you are reasoning
 * about. In summer that is an hour; across the Atlantic it is a day.
 *
 * Everything here works on `YYYY-MM-DD` strings, which is what the
 * Graph API wants and what sorts correctly as text.
 */

/** Today, as the given timezone sees it. */
export function today(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** The hour of day, 0 to 23, as the given timezone sees it. */
export function hourIn(timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).format(new Date());
  return Number.parseInt(hour, 10);
}

/**
 * Moves a date by whole days.
 *
 * Built at midday UTC on purpose: at midnight, adding 24 hours across a
 * daylight saving change lands on the same date again and a window
 * quietly loses a day.
 */
export function addDays(day: string, delta: number): string {
  const base = new Date(`${day}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + delta);
  return base.toISOString().slice(0, 10);
}

/** A window of `days` ending on `end`, both ends included, as Meta wants it. */
export function windowOf(end: string, days: number): { since: string; until: string } {
  return { since: addDays(end, -(days - 1)), until: end };
}

/** Whole days between two dates. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
