/**
 * Sending, through Resend.
 *
 * One rule governs this file: **failing to send must never break what
 * was being done when it was sent.** The caller gets false and carries
 * on. A proposal that was written to the database and could not be
 * emailed is recoverable; one that was emailed and not written is a
 * decision about to be made against nothing.
 *
 * Which is also why the database write happens first everywhere this is
 * called from, and never the other way round.
 */

import type { Email } from "./compose.ts";

const ENDPOINT = "https://api.resend.com/emails";

export type SendResult = { sent: true; id: string } | { sent: false; reason: string };

export async function send(email: Email, apiKey: string): Promise<SendResult> {
  if (!apiKey) return { sent: false, reason: "no api key" };
  if (!email.to || !email.from) return { sent: false, reason: "no sender or recipient" };

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: email.from,
        to: [email.to],
        reply_to: email.replyTo,
        subject: email.subject,
        text: email.text,
        html: email.html,
      }),
    });

    if (!response.ok) {
      // Resend says what was wrong with the message, and that detail is
      // the difference between fixing it and guessing. No credential
      // travels in the body, so it is safe to log.
      return { sent: false, reason: `http ${response.status}: ${(await response.text()).slice(0, 300)}` };
    }

    const body = (await response.json()) as { id?: string };
    return { sent: true, id: body.id ?? "" };
  } catch (err) {
    return { sent: false, reason: `network: ${String(err)}` };
  }
}

/**
 * Remembers that this proposal has been emailed.
 *
 * Kept separate from the send itself so the order is explicit at the
 * call site: send, then record. If recording fails the worst case is one
 * duplicate email, which is a nuisance. If it were the other way round
 * the worst case is a proposal that is marked as sent and never arrived,
 * which is silence.
 */
export async function markEmailed(
  db: D1Database,
  proposalId: number,
  messageId: string,
): Promise<void> {
  await db
    .prepare("update proposals set message_id = ? where id = ?")
    .bind(messageId, proposalId)
    .run();
}

/** Which proposals have not been emailed yet, most worth sending first. */
export async function unsent(db: D1Database, limit: number): Promise<number[]> {
  const rows = await db
    .prepare(
      `select id from proposals
        where state = 'proposed' and message_id is null
        order by json_extract(baseline, '$.weight') desc, created_at asc
        limit ?`,
    )
    .bind(limit)
    .all<{ id: number }>();
  return (rows.results ?? []).map((row) => row.id);
}
