/**
 * The agent Worker: the daily run, and the page that answers a click.
 *
 * This is the half with an address on the internet, so it is also the
 * half that must never be able to spend money. Its Meta token holds
 * `ads_read` and nothing else, and there is no POST to the Graph API
 * anywhere in `src/` except in the executor, which has no `fetch`
 * handler at all. See the README.
 */

import { loadConfig } from "./config.ts";
import { MetaClient } from "./meta/client.ts";
import { loadSnapshot, saveSnapshot, takeSnapshot } from "./meta/snapshot.ts";
import { hydratePixelStats } from "./meta/pixel-stats.ts";
import { runChecks } from "./checks/run.ts";
import { expireStale, openProposals, saveNew, toProposals, type Stored } from "./queue/proposals.ts";
import { compose } from "./mail/compose.ts";
import { createDecisionLinks, decide, redeem } from "./mail/links.ts";
import { markEmailed, send, unsent } from "./mail/send.ts";
import { hourIn, today } from "./dates.ts";

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
  if (staleStats.length > 0) did.push(`no saved pixel stats for ${staleStats.length} pixel(s)`);

  const findings = runChecks(stored.snapshot, config);
  did.push(`${findings.length} findings`);

  const proposals = await toProposals(findings, day);
  const saved = await saveNew(env.DB, proposals);
  did.push(`${saved.length} new, ${proposals.length - saved.length} already open`);

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

  return { ok: true, did };
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

  const moved = await decide(env.DB, claim.proposalId, claim.action, "link");
  if (!moved) {
    return page("Already decided", "This one had a decision recorded before you clicked.", "warn");
  }

  return claim.action === "approve"
    ? page("Approved", "It will be applied on the next run, and you will get an email saying what changed.")
    : page("Discarded", "Nothing will be done. It will not come back unless the situation changes.");
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

    const decision = url.pathname.match(/^\/d\/([A-Za-z0-9]+)$/);
    if (decision?.[1]) {
      return request.method === "POST"
        ? handleDecision(env, decision[1])
        : confirmPage(decision[1]);
    }

    return new Response("Not found", { status: 404 });
  },
};
