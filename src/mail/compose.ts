/**
 * The email, which is the whole product as far as the person reading it
 * is concerned.
 *
 * Everything else in this repository exists to make this message worth
 * opening. So the shape of it is not decoration, it is the design:
 *
 * - **One proposal per email.** A message holding three of them and a
 *   reply saying "yes" is ambiguous, and ambiguity here means something
 *   gets changed that nobody meant to change.
 * - **The figure goes in the subject.** The subject is the only part
 *   that gets read on a phone at a traffic light, and a number is what
 *   makes it worth stopping for.
 * - **What would prove it wrong is in the body.** A proposal with no
 *   stated way of being wrong is an opinion, and opinions do not deserve
 *   a daily email.
 * - **Nothing is sent on a day with nothing to say.** Silence is what
 *   keeps the non-silent days worth reading.
 */

import type { Stored } from "../queue/proposals.ts";
import type { Config } from "../config.ts";

export type Email = {
  to: string;
  from: string;
  replyTo: string;
  subject: string;
  text: string;
  html: string;
};

/** Where a reply to this proposal has to land for it to be understood. */
export function replyAddress(code: string, domain: string): string {
  // The code travels in the address rather than the subject because
  // subjects get edited, translated and prefixed with Re: and Fwd:,
  // while the envelope recipient survives all of it.
  return `ads+${code.toLowerCase()}@${domain}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 14px">${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export type Links = { approve: string; reject: string };

export function compose(
  proposal: Stored,
  config: Config,
  links: Links,
  chatCommand = "/ads",
): Email {
  const urgent = proposal.severity === "urgent";
  const brand = config.brands.find((b) => b.id === proposal.brandId);
  const label = brand ? `${brand.displayName} · ` : "";

  const subject = `[${proposal.code}] ${label}${proposal.title}`;

  // The plain text part is not a fallback nobody sees. It is what a
  // reply quotes, so it has to read correctly underneath the answer.
  const text = [
    proposal.observed,
    "",
    `What to do: ${proposal.change}`,
    proposal.costIfWrong ? `\nIf this is wrong: ${proposal.costIfWrong}` : "",
    proposal.reversible
      ? "\nThis one is reversible."
      : "\nThis one is NOT reversible, so it is worth a conversation first.",
    "",
    "Reply to this email with yes or no. Anything else is kept as a",
    "comment and nothing happens until you say which it is.",
    "",
    `To talk it through: open Claude Code and type ${chatCommand} ${proposal.code}`,
    "",
    `Approve: ${links.approve}`,
    `Discard: ${links.reject}`,
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#F7F7F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1F1F1F">
  <div style="max-width:560px;margin:0 auto;background:#FFFFFF;border-radius:10px;padding:28px">
    <p style="margin:0 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${
      urgent ? "#B42318" : "#6B6B70"
    }">${urgent ? "Costing money now" : "Worth a look"} · ${escapeHtml(proposal.code)}</p>
    <h1 style="margin:0 0 18px;font-size:19px;line-height:1.35;font-weight:600">${escapeHtml(
      proposal.title,
    )}</h1>

    <div style="font-size:14px;line-height:1.65;color:#3A3A3E">${paragraphs(proposal.observed)}</div>

    <div style="margin:18px 0;padding:14px 16px;background:#F4F6FB;border-radius:8px;font-size:14px;line-height:1.6">
      <strong style="display:block;margin-bottom:5px">What to do</strong>
      ${escapeHtml(proposal.change)}
    </div>

    ${
      proposal.costIfWrong
        ? `<p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:#6B6B70"><strong>If this is wrong:</strong> ${escapeHtml(
            proposal.costIfWrong,
          )}</p>`
        : ""
    }

    ${
      proposal.reversible
        ? ""
        : `<p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:#B42318"><strong>Not reversible.</strong> Worth talking through before deciding.</p>`
    }

    <div style="margin:22px 0 18px">
      <a href="${links.approve}" style="display:inline-block;padding:11px 20px;background:#1F1F1F;color:#FFFFFF;text-decoration:none;border-radius:7px;font-size:14px;font-weight:600">Approve</a>
      <a href="${links.reject}" style="display:inline-block;padding:11px 20px;margin-left:8px;color:#3A3A3E;text-decoration:none;border-radius:7px;font-size:14px;border:1px solid #D9D9DE">Discard</a>
    </div>

    <p style="margin:0;font-size:13px;line-height:1.65;color:#6B6B70">
      Or just reply to this email with <strong>yes</strong> or <strong>no</strong>.
      Anything else is kept as a comment and nothing happens until you say which it is.<br>
      To talk it through: open Claude Code and type <code>${escapeHtml(chatCommand)} ${escapeHtml(
        proposal.code,
      )}</code>.
    </p>
  </div>
</body></html>`;

  return {
    to: config.notify.to,
    from: config.notify.from,
    replyTo: replyAddress(proposal.code, config.notify.replyDomain),
    subject,
    text,
    html,
  };
}
