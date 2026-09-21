/**
 * The weekly list of things that were agreed to and need a person.
 *
 * Saying yes to a proposal of that kind does not change anything in
 * Meta: it records agreement and nothing else. Until this existed, that
 * was the last anybody heard of it. Nothing applied it, nothing asked
 * about it again, and the duplicate guard stopped the rule that found it
 * from raising it a second time while it sat there approved, so the
 * problem carried on costing money with no trace of it anywhere a person
 * looks. Agreeing was quieter than ignoring.
 *
 * Which is why this message is built the opposite way round to the
 * proposal email:
 *
 * - **Everything in one message, not one each.** A proposal asks for a
 *   decision and deserves its own message. This asks for nothing, it
 *   reports a state, and a state arriving in five envelopes reads as
 *   five problems.
 * - **Oldest first, with the age on every line.** The age is the whole
 *   point. A list that does not say how long things have been waiting is
 *   a list that gets skimmed.
 * - **One link per line, and it means "done".** A list with no way of
 *   getting shorter becomes something to ignore, and then it is back to
 *   where it started.
 * - **Nothing to say, nothing sent.** Same rule as the daily run. An
 *   empty list arriving every Monday is how somebody learns to leave
 *   this sender unread.
 */

import type { ListItem } from "../queue/proposals.ts";
import type { Config } from "../config.ts";
import type { Email } from "./compose.ts";
import { daysBetween } from "../dates.ts";

export type Waiting = { item: ListItem; done: string };

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** How long it has been sitting there, said the way a person would. */
export function age(since: string, today: string): string {
  const days = Math.max(0, daysBetween(since, today));
  if (days === 0) return "since today";
  if (days === 1) return "since yesterday";
  if (days < 14) return `for ${days} days`;
  return `for ${Math.floor(days / 7)} weeks`;
}

export function composeWorklist(
  waiting: Waiting[],
  config: Config,
  today: string,
  chatCommand = "/ads",
): Email {
  const oldest = waiting[0];
  const count = waiting.length;

  // The subject carries the count and the age of the oldest, because
  // those are the two numbers that decide whether this gets opened now
  // or at the weekend.
  const subject =
    count === 1
      ? `The list: 1 thing, waiting ${age(oldest!.item.since, today)}`
      : `The list: ${count} things, the oldest waiting ${age(oldest!.item.since, today)}`;

  const brandOf = (brandId: string | null): string => {
    const brand = config.brands.find((b) => b.id === brandId);
    return brand ? `${brand.displayName} · ` : "";
  };

  const text = [
    count === 1
      ? "One thing was agreed to and still needs doing by hand."
      : `${count} things were agreed to and still need doing by hand.`,
    "Nothing here applies itself, and nothing here will be raised again",
    "while it is on this list.",
    "",
    ...waiting.flatMap(({ item, done }) => [
      `${item.code} · ${brandOf(item.brandId)}waiting ${age(item.since, today)}`,
      item.title,
      `  ${item.change}`,
      `  Done: ${done}`,
      "",
    ]),
    `To talk one through: open Claude Code and type ${chatCommand} ${oldest!.item.code}`,
  ].join("\n");

  const rows = waiting
    .map(
      ({ item, done }) => `
    <div style="padding:16px 0;border-top:1px solid #ECECEF">
      <p style="margin:0 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6B6B70">${escapeHtml(
        item.code,
      )} · ${escapeHtml(brandOf(item.brandId))}waiting ${escapeHtml(age(item.since, today))}</p>
      <p style="margin:0 0 8px;font-size:15px;line-height:1.45;font-weight:600">${escapeHtml(
        item.title,
      )}</p>
      <p style="margin:0 0 10px;font-size:14px;line-height:1.6;color:#3A3A3E">${escapeHtml(
        item.change,
      )}</p>
      <a href="${done}" style="display:inline-block;padding:8px 14px;color:#3A3A3E;text-decoration:none;border-radius:7px;font-size:13px;border:1px solid #D9D9DE">This one is done</a>
    </div>`,
    )
    .join("");

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#F7F7F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1F1F1F">
  <div style="max-width:560px;margin:0 auto;background:#FFFFFF;border-radius:10px;padding:28px">
    <p style="margin:0 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6B6B70">Agreed to, not done</p>
    <h1 style="margin:0 0 14px;font-size:19px;line-height:1.35;font-weight:600">${
      count === 1 ? "One thing is on the list" : `${count} things are on the list`
    }</h1>
    <p style="margin:0 0 6px;font-size:14px;line-height:1.65;color:#3A3A3E">
      None of these applies itself, and none of them will be raised again while
      it is sitting here. Marking one done takes it off the list and changes
      nothing in Meta: it is a record that the work happened, not the work.
    </p>
    ${rows}
    <p style="margin:18px 0 0;padding-top:16px;border-top:1px solid #ECECEF;font-size:13px;line-height:1.65;color:#6B6B70">
      To talk one through: open Claude Code and type <code>${escapeHtml(chatCommand)} ${escapeHtml(
        oldest!.item.code,
      )}</code>.
    </p>
  </div>
</body></html>`;

  return {
    to: config.notify.to,
    from: config.notify.from,
    // No proposal code in the address: this message is about several of
    // them, so a reply cannot be attributed to one and must not be
    // silently filed against the first.
    replyTo: `${config.notify.replyMailbox}@${config.notify.replyDomain}`,
    subject,
    text,
    html,
  };
}
