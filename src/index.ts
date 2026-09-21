/**
 * The agent Worker: the daily run, and the page that answers a click.
 *
 * This is the half with an address on the internet, so it is also the
 * half that must never be able to spend money. Its Meta token holds
 * `ads_read` and nothing else, and there is no POST to the Graph API
 * anywhere in `src/` except in the executor, which has no `fetch`
 * handler at all. See the README.
 */

import { loadConfig, type Config } from "./config.ts";
import { MetaClient } from "./meta/client.ts";
import { loadSnapshot, saveSnapshot, takeSnapshot } from "./meta/snapshot.ts";
import { hydratePixelStats } from "./meta/pixel-stats.ts";
import { context, runChecks } from "./checks/run.ts";
import {
  addComment,
  byCode,
  expireStale,
  fromAnalyst,
  onTheList,
  openProposals,
  saveNew,
  toProposals,
  type Stored,
} from "./queue/proposals.ts";
import { noticeSent, recordNotice } from "./queue/notices.ts";
import { summarise } from "./analyst/summary.ts";
import { analyse } from "./analyst/analyst.ts";
import { compose } from "./mail/compose.ts";
import { composeWorklist, type Waiting } from "./mail/worklist.ts";
import {
  addressOf,
  codeFrom,
  couldNotAct,
  fetchReceived,
  readAnswer,
  signatureIsValid,
  type ReceivedEvent,
} from "./mail/inbound.ts";
import { createDecisionLinks, createDoneLink, decide, markDone, redeem } from "./mail/links.ts";
import { markEmailed, send, unsent } from "./mail/send.ts";
import { hourIn, today, weekdayOf } from "./dates.ts";

export type Env = {
  DB: D1Database;
  PUBLIC_URL: string;
  META_ADS_TOKEN_READ: string;
  RESEND_API_KEY: string;
  /**
   * Lets the daily run be triggered without waiting for the clock.
   *
   * Worth having because the alternative is waiting until tomorrow
   * morning to find out whether a change works. It skips the hour check
   * and nothing else: the duplicate guards still hold, so this cannot be
   * used to send the same proposal twice.
   *
   * Unset means the route does not exist at all, which is the right
   * default for an installation that does not need it.
   */
  RUN_TOKEN?: string;
  /** Unset means the model half simply does not run. */
  ANTHROPIC_API_KEY?: string;
  /**
   * Signs the inbound email webhook. Unset means replies are not read at
   * all, which is the right default: an endpoint that decides what
   * happens to somebody's advertising and cannot tell who is calling it
   * should not exist.
   */
  RESEND_WEBHOOK_SECRET?: string;
};

/**
 * The hour, in the account's timezone, when the day's work happens.
 *
 * The cron fires hourly and the code decides, rather than the schedule
 * being set to the right hour. Cron runs in UTC and half the world
 * changes its clocks twice a year, so a schedule pinned to 08:00 UTC
 * drifts to 09:00 local for six months without anybody noticing.
 */
const RUN_AT = 8;

async function dailyRun(env: Env, force: boolean): Promise<{ ok: boolean; did: string[] }> {
  const config = await loadConfig(env.DB);
  if (!config) return { ok: true, did: ["nothing configured yet"] };
  if (!config.enabled) return { ok: true, did: ["switched off in settings"] };

  const day = today(config.timeZone);
  if (!force && hourIn(config.timeZone) !== RUN_AT) {
    return { ok: true, did: [`not the hour yet (runs at ${RUN_AT}:00 ${config.timeZone})`] };
  }

  const did: string[] = [];

  // Expiring first, so a problem that is still there can be raised again
  // today with today's figures instead of waiting behind a stale copy.
  const expired = await expireStale(env.DB, config.proposalTtlDays);
  if (expired > 0) did.push(`${expired} expired without a decision`);

  // One picture per day. If today's is already taken, it is reused
  // rather than fetched again: the checks are deterministic, so a second
  // fetch buys nothing and spends the account's call quota.
  let stored = await loadSnapshot(env.DB, day);
  if (!stored) {
    const client = new MetaClient({
      token: env.META_ADS_TOKEN_READ,
      accountId: config.accountId,
    });
    const result = await takeSnapshot(client, config, day);
    await saveSnapshot(env.DB, result);
    did.push(`snapshot: ${result.calls} calls, usable: ${result.complete}`);
    if (result.missing.length > 0) did.push(`could not read: ${result.missing.join(", ")}`);
    stored = { snapshot: result.snapshot, complete: result.complete };
  } else {
    did.push("snapshot already taken today, reused");
  }

  // The numbers this Worker is not allowed to fetch, left by the
  // executor. Missing them costs two checks and nothing else.
  const staleStats = await hydratePixelStats(env.DB, stored.snapshot);
  if (staleStats.length > 0) {
    // Either the executor has never run or it has stopped. Both look
    // the same from here and both mean the same thing: the two match
    // quality checks have nothing to read today.
    did.push(`no usable pixel stats for ${staleStats.length} pixel(s), is the executor running?`);
  }

  const findings = runChecks(stored.snapshot, config);
  did.push(`${findings.length} findings`);

  const proposals = await toProposals(findings, day);
  const saved = await saveNew(env.DB, proposals);
  did.push(`${saved.length} new, ${proposals.length - saved.length} already open`);

  // The model half runs last and only on a usable snapshot. Everything
  // above has already been saved, so a failure here costs the judgement
  // and nothing else.
  if (!stored.complete) {
    did.push("snapshot incomplete: the analyst did not run");
  } else if (env.ANTHROPIC_API_KEY) {
    try {
      const summary = summarise({
        snapshot: stored.snapshot,
        config,
        findings,
        pendingReview: context(stored.snapshot).pendingReview,
        history: await recentHistory(env.DB),
        baseline: null,
      });

      const result = await analyse(summary, config, day, env.DB, env.ANTHROPIC_API_KEY);
      if (!result.ran) {
        did.push(`analyst skipped: ${result.why}`);
      } else {
        const fromModel = await fromAnalyst(result.proposals, day, config.brands);
        const savedModel = await saveNew(env.DB, fromModel);
        saved.push(...savedModel);
        did.push(
          `analyst: ${result.note}, ${savedModel.length} new, ` +
            `${result.costEur.toFixed(4)} EUR`,
        );
      }
    } catch (err) {
      console.error("[analyst] fell over:", err);
      did.push("analyst fell over, see the log");
    }
  }

  // What gets emailed is "still waiting and not emailed yet", not "new
  // today". The difference matters: a proposal created on a run whose
  // email failed would otherwise never be sent again, because it is not
  // new tomorrow. It would sit in the queue looking decided-upon while
  // nobody had ever seen it.
  const waiting = await unsent(env.DB, config.maxProposalsPerDay);
  const byId = new Map(saved.map((p) => [p.id, p]));
  const toSend = waiting.length > 0 ? await loadForSending(env.DB, waiting, byId) : [];

  let sentCount = 0;
  for (const proposal of toSend) {
    const links = await createDecisionLinks(
      env.DB,
      proposal.id,
      env.PUBLIC_URL,
      config.proposalTtlDays,
    );
    const result = await send(compose(proposal, config, links), env.RESEND_API_KEY);
    if (result.sent) {
      await markEmailed(env.DB, proposal.id, result.id);
      sentCount++;
    } else {
      // Not fatal and not silent. The proposal is already saved, so it
      // will be picked up by the next run's unsent list.
      console.error(`[mail] ${proposal.code}: ${result.reason}`);
    }
  }
  did.push(`${sentCount} emailed of ${waiting.length} waiting`);

  const list = await worklistEmail(env, config, day);
  if (list) did.push(list);

  return { ok: true, did };
}

/**
 * The weekly reminder of what was agreed to and not done.
 *
 * Deliberately after the proposals and not instead of them: they are
 * different questions. One asks for a decision, this one reports what
 * the decisions already made are still waiting on.
 */
async function worklistEmail(
  env: Env,
  config: Config,
  day: string,
): Promise<string | null> {
  if (config.worklistWeekday === 0) return null;
  if (weekdayOf(day) !== config.worklistWeekday) return null;
  if (await noticeSent(env.DB, "worklist", day)) return "the list already went out today";

  const items = await onTheList(env.DB);
  if (items.length === 0) return "nothing on the list";

  const waiting: Waiting[] = [];
  for (const item of items) {
    waiting.push({ item, done: await createDoneLink(env.DB, item.id, env.PUBLIC_URL) });
  }

  const result = await send(composeWorklist(waiting, config, day), env.RESEND_API_KEY);
  if (!result.sent) {
    console.error(`[mail] worklist: ${result.reason}`);
    return "the list could not be sent, see the log";
  }

  // Written after the send, not before: a mark written first turns a
  // failed send into a week of silence about work nobody is doing.
  await recordNotice(env.DB, "worklist", day);
  return `the list emailed, ${waiting.length} on it`;
}

/**
 * A reply to a proposal, turned into a decision.
 *
 * Answers 200 to everything it has verified, including the cases where
 * it decides to do nothing. A non-200 makes Resend retry, and retrying
 * cannot help a message that was read correctly and meant nothing: it
 * would just arrive again every few minutes. The one exception is a
 * signature that does not check out, which is not a message from Resend
 * at all.
 */
async function handleInbound(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  if (!(await signatureIsValid(env.RESEND_WEBHOOK_SECRET, request.headers, raw))) {
    // Deliberately says nothing about why. Whoever is knocking does not
    // need to know whether the secret is unset, the timestamp too old or
    // the signature wrong.
    return new Response("no", { status: 401 });
  }

  let event: ReceivedEvent;
  try {
    event = JSON.parse(raw) as ReceivedEvent;
  } catch {
    return new Response("ok");
  }
  if (event.type !== "email.received" || !event.data?.email_id) return new Response("ok");

  const emailId = event.data.email_id;
  // Svix retries until it gets a 200, and a retry that arrives after the
  // first attempt already decided something must not decide it again.
  if (await noticeSent(env.DB, "inbound", emailId)) return new Response("ok");

  const config = await loadConfig(env.DB);
  if (!config) return new Response("ok");

  const email = await fetchReceived(emailId, env.RESEND_API_KEY);
  if (!email) {
    // The only case worth a retry: the body could not be read, and it
    // may be there in a minute.
    return new Response("later", { status: 503 });
  }

  await recordNotice(env.DB, "inbound", emailId);

  const code = codeFrom([...(email.received_for ?? []), ...(email.to ?? [])]);
  if (!code) {
    console.log(`[inbound] ${emailId}: no proposal code in the address`);
    return new Response("ok");
  }

  const sender = addressOf(email.from);
  if (!config.notify.approvers.some((who) => who.toLowerCase() === sender)) {
    // Not an error and not worth an email back: somebody who is not an
    // approver writing to this address is exactly what should happen to
    // nothing.
    console.log(`[inbound] ${code}: ${sender} is not an approver`);
    return new Response("ok");
  }

  const proposal = await byCode(env.DB, code);
  if (!proposal) {
    console.log(`[inbound] ${code}: no such proposal`);
    return new Response("ok");
  }

  const answer = readAnswer(email.text ?? stripTags(email.html ?? ""));

  if (answer.kind === "unclear") {
    await addComment(env.DB, proposal.id, answer.said);
    await send(
      couldNotAct(
        sender,
        code,
        `I could not read that as a yes or a no, so I kept it on ${code} as a comment and left it waiting.`,
        config,
      ),
      env.RESEND_API_KEY,
    );
    return new Response("ok");
  }

  const moved = await decide(env.DB, proposal.id, answer.kind, "email");
  if (!moved) {
    await send(
      couldNotAct(
        sender,
        code,
        `${code} was already ${proposal.state} before your reply arrived, so nothing changed.`,
        config,
      ),
      env.RESEND_API_KEY,
    );
    return new Response("ok");
  }

  // Said and done. What happens next says so on its own: an automatic
  // change emails what it did, and one that needs a person turns up on
  // the weekly list until it is marked done.
  console.log(`[inbound] ${code}: ${answer.kind} by email`);
  return new Response("ok");
}

/** A plain text reading of an HTML only reply, good enough for one word. */
function stripTags(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr)>/gi, "\n")
    .replace(/<blockquote[\s\S]*/i, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Which of the three kinds a proposal is, for wording the reply. */
async function handlingOf(db: D1Database, id: number): Promise<string> {
  const row = await db
    .prepare("select handling from proposals where id = ?")
    .bind(id)
    .first<{ handling: string }>();
  return row?.handling ?? "work";
}

/**
 * What was proposed recently and what came of it.
 *
 * Given to the model so it can see its own record: what got rejected,
 * and what the owner said when rejecting it. Without that it argues the
 * same point every week, having no idea it already lost that argument.
 */
async function recentHistory(
  db: D1Database,
): Promise<{ code: string; title: string; state: string; comment: string | null }[]> {
  const rows = await db
    .prepare(
      `select code, title, state, comment from proposals
        where created_at > datetime('now', '-30 days')
          and state in ('approved', 'rejected', 'applied', 'measured')
        order by state_at desc limit 12`,
    )
    .all<{ code: string; title: string; state: string; comment: string | null }>();
  return rows.results ?? [];
}

/**
 * The rows to email, preferring the ones this run just built.
 *
 * Reading them back from the database for the ones it did not build, so
 * a proposal from a previous run whose email failed comes out in exactly
 * the same shape as a fresh one and there is only one code path for
 * composing.
 */
async function loadForSending(
  db: D1Database,
  ids: number[],
  fresh: Map<number, Stored>,
): Promise<Stored[]> {
  const missing = ids.filter((id) => !fresh.has(id));
  const loaded = new Map<number, Stored>();

  if (missing.length > 0) {
    for (const row of await openProposals(db, 50)) {
      if (missing.includes(row.id)) loaded.set(row.id, row);
    }
  }

  return ids
    .map((id) => fresh.get(id) ?? loaded.get(id))
    .filter((row): row is Stored => row !== undefined);
}

/** The page somebody lands on after clicking a link in the email. */
function page(title: string, body: string, tone: "ok" | "warn" = "ok"): Response {
  const colour = tone === "ok" ? "#1F1F1F" : "#B42318";
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;padding:48px 16px;background:#F7F7F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<div style="max-width:420px;margin:0 auto;background:#fff;border-radius:10px;padding:28px;text-align:center">
<h1 style="margin:0 0 10px;font-size:18px;color:${colour}">${title}</h1>
<p style="margin:0;font-size:14px;line-height:1.6;color:#3A3A3E">${body}</p>
</div></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/**
 * Confirming before acting, rather than acting on the GET.
 *
 * Mail scanners, link previewers and corporate security gateways all
 * follow links in email before a person ever sees them. A decision made
 * on the GET would be made by a robot, once, and the person clicking
 * afterwards would be told it was already decided.
 */
function confirmPage(token: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confirm</title></head>
<body style="margin:0;padding:48px 16px;background:#F7F7F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<div style="max-width:420px;margin:0 auto;background:#fff;border-radius:10px;padding:28px;text-align:center">
<p style="margin:0 0 18px;font-size:15px;line-height:1.6">One more tap to confirm.</p>
<form method="post" action="/d/${encodeURIComponent(token)}">
<button type="submit" style="padding:11px 24px;background:#1F1F1F;color:#fff;border:0;border-radius:7px;font-size:14px;font-weight:600;cursor:pointer">Confirm</button>
</form>
</div></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

async function handleDecision(env: Env, token: string): Promise<Response> {
  const claim = await redeem(env.DB, token);
  if (!claim.ok) {
    // Every failure says the same thing on purpose. Telling a stranger
    // which links exist, which have been used and which have expired is
    // a map for guessing at the rest.
    return page("That link is no longer valid", "It may have been used already or expired.", "warn");
  }

  // Taking something off the list is not a decision about it: the
  // decision was made when it was approved, and this says the work has
  // since been done. So it moves a different state and answers on its
  // own before `decide` gets a chance to refuse it.
  if (claim.action === "done") {
    return (await markDone(env.DB, claim.proposalId))
      ? page("Off the list", "Nothing was changed in Meta by clicking: this only records that it is done.")
      : page("Already off the list", "It was marked done before you clicked, or it never reached the list.", "warn");
  }

  const handling = await handlingOf(env.DB, claim.proposalId);
  const moved = await decide(env.DB, claim.proposalId, claim.action, "link");
  if (!moved) {
    return page("Already decided", "This one had a decision recorded before you clicked.", "warn");
  }

  if (claim.action !== "approve") {
    return page("Discarded", "Nothing will be done. It will not come back unless the situation changes.");
  }

  // The same three consequences as the button, said again on arrival.
  // Somebody who clicked from a phone a day later should not have to
  // remember which kind it was.
  return handling === "auto"
    ? page("Approved", "It will be applied within the hour, and you will get an email saying exactly what changed.")
    : page(
        "On the list",
        "It needs a person, so nothing is applied on its own. It comes back in " +
          "the weekly list of outstanding work until it is marked done.",
      );
}

export default {
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    try {
      const result = await dailyRun(env, false);
      console.log(`[run] ${result.did.join(" | ")}`);
    } catch (err) {
      // A scheduled handler that throws is a run nobody hears about.
      console.error("[run] failed:", err);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Constant-time-ish comparison is overkill for a trigger that does
    // no damage, but an unset token must never match an absent header.
    if (url.pathname === "/run" && request.method === "POST") {
      const given = request.headers.get("x-run-token");
      if (!env.RUN_TOKEN || !given || given !== env.RUN_TOKEN) {
        return new Response("no", { status: 401 });
      }
      const result = await dailyRun(env, true);
      return Response.json(result);
    }

    if (url.pathname === "/inbound" && request.method === "POST") {
      return handleInbound(request, env);
    }

    const decision = url.pathname.match(/^\/d\/([A-Za-z0-9]+)$/);
    if (decision?.[1]) {
      return request.method === "POST"
        ? handleDecision(env, decision[1])
        : confirmPage(decision[1]);
    }

    return new Response("Not found", { status: 404 });
  },
};
