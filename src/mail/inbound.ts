/**
 * Deciding by replying to the email.
 *
 * The buttons work and always did. This exists because the buttons are
 * not where somebody is when they decide: they are reading the message
 * on a phone, and the natural thing to do with an email that asks a
 * question is to answer it. Every proposal has invited a reply since the
 * first one went out; until now the invitation was a lie, and for a
 * while the replies did not even bounce visibly, they bounced to the
 * person who sent them two days later.
 *
 * Three rules, and each one is a way this could go wrong quietly:
 *
 * - **The signature is checked before anything is read.** This endpoint
 *   decides what happens to somebody's advertising and its address is
 *   public. An unsigned POST that reached the parser would be a stranger
 *   approving changes.
 * - **Only an approver's answer counts.** A forwarded thread, a mailing
 *   list, a colleague replying to all: the envelope says who wrote it
 *   and anyone else is read as noise.
 * - **A "yes" has to be a yes on its own.** "Yes, but lower the budget"
 *   is a conversation, not an approval, and the cost of guessing wrong
 *   is a change nobody agreed to. Anything that is not a bare yes or no
 *   is kept as a comment and the proposal goes on waiting, which is
 *   exactly what the emails already promise.
 */

import type { Config } from "../config.ts";
import type { Email } from "./compose.ts";

/** What Resend sends when an email arrives. The body is not in it. */
export type ReceivedEvent = {
  type: string;
  data?: { email_id?: string; to?: string[]; received_for?: string[]; from?: string };
};

/** What the API gives back when asked for the whole thing. */
export type ReceivedEmail = {
  id: string;
  from: string;
  to: string[];
  received_for?: string[];
  subject?: string;
  text?: string | null;
  html?: string | null;
};

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** Compares without leaking where two strings start to differ. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let differences = 0;
  for (let i = 0; i < a.length; i++) differences |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return differences === 0;
}

/**
 * Whether this really came from Resend, and recently.
 *
 * The signed content is the id, the timestamp and the body exactly as it
 * arrived, which is why the caller passes the raw text and not a parsed
 * object: JSON parsed and re-serialised is a different string, and the
 * signature is over bytes.
 *
 * The timestamp window is what stops a captured request being replayed
 * later. Five minutes is what Svix recommends and it is generous enough
 * for a retry.
 */
export async function signatureIsValid(
  secret: string | undefined,
  headers: Headers,
  rawBody: string,
  now = Date.now(),
): Promise<boolean> {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!secret || !id || !timestamp || !signatures) return false;

  const age = Math.abs(now / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(secret.replace(/^whsec_/, "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`),
  );
  const expected = bytesToBase64(new Uint8Array(mac));

  // The header carries a space separated list, so that a secret can be
  // rotated without a gap where neither the old nor the new one works.
  return signatures.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    return version === "v1" && value !== undefined && sameSecret(value, expected);
  });
}

/**
 * The proposal a reply is about, read out of the address it was sent to.
 *
 * The code travels in the local part because that is the only piece of
 * an email that survives being replied to. Subjects get edited,
 * translated and prefixed, and a person forwarding a thread rewrites
 * everything except who it is addressed to.
 */
export function codeFrom(addresses: (string | undefined)[]): string | null {
  for (const address of addresses) {
    if (!address) continue;
    const match = address.match(/\+\s*(ads-?\d{1,6})@/i);
    if (!match?.[1]) continue;
    const digits = match[1].replace(/\D/g, "");
    return `ADS-${digits.padStart(4, "0")}`;
  }
  return null;
}

/** The address out of `Name <someone@example.com>`, lowercased. */
export function addressOf(from: string | undefined): string {
  if (!from) return "";
  const match = from.match(/<([^>]+)>/);
  return (match?.[1] ?? from).trim().toLowerCase();
}

const YES = ["si", "sí", "yes", "ok", "okay", "dale", "adelante", "aprobado", "apruebo", "aprobar"];
const NO = ["no", "nope", "descartar", "descartado", "rechazar", "rechazo", "rechazado"];

/**
 * Everything above the quoted thread.
 *
 * A reply from a phone puts the answer first and the entire history
 * underneath it. Reading the whole message would find the word "yes"
 * somewhere in the original email nearly every time.
 */
export function ownWords(body: string): string {
  const lines: string[] = [];
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(">")) break;
    // The line a mail client writes above the quote, in the languages
    // this mailbox actually sees, plus the separator a signature uses.
    if (/^(on|el)\b.*(wrote|escribió|escribio):$/i.test(trimmed)) break;
    if (/^(de|from|enviado|sent|-{3,}\s*original)\b.*:/i.test(trimmed)) break;
    if (trimmed === "--" || trimmed === "—") break;
    lines.push(trimmed);
  }
  return lines.join("\n").trim();
}

export type Answer =
  | { kind: "approve" | "reject" }
  | { kind: "unclear"; said: string };

/**
 * What the reply means, if it means one of two things.
 *
 * Deliberately unforgiving. The first line has to be a yes or a no and
 * nothing else, because the alternative is a rule that has to judge
 * whether "yes but" is a yes, and getting that wrong spends money on a
 * change the person was still thinking about.
 */
export function readAnswer(body: string): Answer {
  const said = ownWords(body);
  const first = said.split("\n").find((line) => line.length > 0) ?? "";
  const word = first
    .toLowerCase()
    .replace(/[.,;:!¡¿?"'`]/g, "")
    .trim();

  if (YES.includes(word)) return { kind: "approve" };
  if (NO.includes(word)) return { kind: "reject" };
  return { kind: "unclear", said };
}

/**
 * The only email this half ever sends, and only when it could not do
 * what the reply asked for.
 *
 * Silence is the acknowledgement when it worked: the change either
 * arrives as its own email within the hour or turns up on the weekly
 * list. An extra message for every decision would teach somebody to
 * stop reading this sender, which is the one thing the whole project
 * cannot afford.
 */
export function couldNotAct(
  to: string,
  code: string,
  why: string,
  config: Config,
): Email {
  const text = `${why}\n\nNothing was applied. The buttons in the original email still work.`;
  return {
    to,
    from: config.notify.from,
    replyTo: `${config.notify.replyMailbox}+${code.toLowerCase()}@${config.notify.replyDomain}`,
    subject: `Re: [${code}] I did not act on that`,
    text,
    html: `<!doctype html>
<html><body style="margin:0;padding:24px;background:#F7F7F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1F1F1F">
  <div style="max-width:560px;margin:0 auto;background:#FFFFFF;border-radius:10px;padding:28px">
    <p style="margin:0 0 12px;font-size:15px;line-height:1.6">${why
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")}</p>
    <p style="margin:0;font-size:13px;line-height:1.6;color:#6B6B70">Nothing was applied. The buttons in the original email still work.</p>
  </div>
</body></html>`,
  };
}

/** Asks Resend for the part of the email it does not put in the webhook. */
export async function fetchReceived(
  emailId: string,
  apiKey: string,
): Promise<ReceivedEmail | null> {
  try {
    const response = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      console.error(`[inbound] could not read ${emailId}: http ${response.status}`);
      return null;
    }
    return (await response.json()) as ReceivedEmail;
  } catch (err) {
    console.error(`[inbound] could not read ${emailId}:`, err);
    return null;
  }
}
