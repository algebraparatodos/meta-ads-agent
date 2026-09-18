/**
 * The executor Worker: the half that can spend money, and cannot be
 * reached.
 *
 * There is no `fetch` handler in this file, deliberately, and
 * `workers_dev` is off in its config. It has no address on the internet.
 * The only things that reach it are its own clock and rows already
 * written to the shared database by the other Worker, which itself holds
 * a token that cannot spend.
 *
 * That arrangement exists because Meta will not let you narrow a token
 * once it carries `ads_management`. Being careful is not a control. This
 * is: the half an attacker can reach cannot spend, and the half that can
 * spend has no door.
 *
 * It does two jobs on each run:
 *
 * 1. Applies whatever has been approved and can be applied unattended.
 * 2. Fetches the pixel statistics, which are the one read in this
 *    project that `ads_read` is not allowed to make.
 */

import { loadConfig } from "./config.ts";
import { MetaClient } from "./meta/client.ts";
import { refreshPixelStats } from "./meta/pixel-stats.ts";
import { apply, type WriteResult } from "./meta/writer.ts";
import { send } from "./mail/send.ts";
import type { Action } from "./checks/types.ts";

export type Env = {
  DB: D1Database;
  /** The one with ads_management. It lives here and nowhere else. */
  META_ADS_TOKEN_WRITE: string;
  RESEND_API_KEY: string;
};

/** Rows this Worker is allowed to act on. */
type Pending = {
  id: number;
  code: string;
  title: string;
  action: string;
  handling: string;
  brand_id: string | null;
};

/**
 * Applies one proposal and records exactly what happened.
 *
 * The execution row is written whether it worked or not, and before the
 * proposal's state moves. A change that was made and not recorded is
 * worse than one that was recorded and not made: the second is visible.
 */
async function runOne(env: Env, row: Pending): Promise<{ ok: boolean; detail: string }> {
  let action: Action;
  try {
    action = JSON.parse(row.action) as Action;
  } catch {
    await fail(env, row, "the stored action is not readable");
    return { ok: false, detail: `${row.code}: unreadable action` };
  }

  const started = await env.DB.prepare(
    `insert into executions (proposal_id, status, request) values (?, 'running', ?) returning id`,
  )
    .bind(row.id, row.action)
    .first<{ id: number }>();

  let result: WriteResult;
  try {
    result = await apply(action, env.META_ADS_TOKEN_WRITE);
  } catch (err) {
    result = {
      ok: false,
      request: action,
      response: null,
      readback: null,
      undo: null,
      error: `threw: ${String(err).slice(0, 200)}`,
    };
  }

  await env.DB.prepare(
    `update executions
        set finished_at = datetime('now'), status = ?, response = ?, readback = ?,
            undo = ?, error = ?
      where id = ?`,
  )
    .bind(
      result.ok ? "done" : result.error?.includes("does not show it") ? "mismatch" : "failed",
      JSON.stringify(result.response),
      JSON.stringify(result.readback),
      result.undo ? JSON.stringify(result.undo) : null,
      result.error,
      started?.id ?? 0,
    )
    .run();

  if (!result.ok) {
    await fail(env, row, result.error ?? "unknown");
    return { ok: false, detail: `${row.code}: ${result.error}` };
  }

  await env.DB.prepare(
    `update proposals set state = 'applied', state_at = datetime('now'),
            applied_at = datetime('now')
      where id = ? and state = 'approved'`,
  )
    .bind(row.id)
    .run();

  return { ok: true, detail: `${row.code}: applied` };
}

/**
 * Moves a proposal to failed rather than leaving it approved.
 *
 * An approved proposal that cannot be applied would be retried on every
 * run, for ever, hitting the same wall each time. Failing it stops that
 * and makes the problem visible instead of loud.
 */
async function fail(env: Env, row: Pending, why: string): Promise<void> {
  await env.DB.prepare(
    `update proposals
        set state = 'failed', state_at = datetime('now'),
            comment = coalesce(comment || ' | ', '') || ?
      where id = ?`,
  )
    .bind(`could not apply: ${why}`.slice(0, 500), row.id)
    .run();
}

async function reportBack(
  env: Env,
  done: { ok: boolean; detail: string }[],
): Promise<void> {
  const config = await loadConfig(env.DB);
  if (!config || done.length === 0) return;

  const worked = done.filter((d) => d.ok);
  const broke = done.filter((d) => !d.ok);

  const lines = [
    worked.length > 0 ? `Applied:\n${worked.map((d) => `  ${d.detail}`).join("\n")}` : null,
    broke.length > 0 ? `Could not apply:\n${broke.map((d) => `  ${d.detail}`).join("\n")}` : null,
    "",
    "Each change was read back from Meta after making it. Anything listed",
    "as applied is confirmed present on the object, not merely accepted.",
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  await send(
    {
      to: config.notify.to,
      from: config.notify.from,
      replyTo: config.notify.to,
      subject:
        broke.length > 0
          ? `Applied ${worked.length}, could not apply ${broke.length}`
          : `Applied ${worked.length} change${worked.length === 1 ? "" : "s"}`,
      text: lines,
      html: `<pre style="font:14px/1.6 ui-monospace,monospace;white-space:pre-wrap">${lines
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")}</pre>`,
    },
    env.RESEND_API_KEY,
  );
}

async function run(env: Env): Promise<string[]> {
  const config = await loadConfig(env.DB);
  if (!config) return ["nothing configured yet"];
  if (!config.enabled) return ["switched off in settings"];

  const did: string[] = [];

  // The read this Worker exists to make on behalf of the other one.
  // Done first, so a failure applying something does not cost it.
  try {
    const client = new MetaClient({
      token: env.META_ADS_TOKEN_WRITE,
      accountId: config.accountId,
    });
    const stats = await refreshPixelStats(client, config, env.DB);
    did.push(`pixel stats: ${stats.updated.length} updated, ${stats.failed.length} failed`);
  } catch (err) {
    console.error("[executor] pixel stats:", err);
    did.push("pixel stats failed, see the log");
  }

  // Only what has been approved, is meant to be applied unattended, and
  // carries an action. Everything else is somebody's job, not this
  // Worker's, however clearly it is described.
  const pending = await env.DB.prepare(
    `select id, code, title, action, handling, brand_id
       from proposals
      where state = 'approved' and handling = 'auto' and action is not null
      order by id limit 10`,
  ).all<Pending>();

  const rows = pending.results ?? [];
  if (rows.length === 0) {
    did.push("nothing approved waiting to be applied");
    return did;
  }

  const done: { ok: boolean; detail: string }[] = [];
  for (const row of rows) {
    done.push(await runOne(env, row));
  }

  did.push(`${done.filter((d) => d.ok).length} applied, ${done.filter((d) => !d.ok).length} failed`);

  try {
    await reportBack(env, done);
  } catch (err) {
    // Never the reason a change is lost. It is already applied and
    // recorded; what failed is telling somebody about it.
    console.error("[executor] could not report back:", err);
  }

  return did;
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    try {
      const did = await run(env);
      console.log(`[executor] ${did.join(" | ")}`);
    } catch (err) {
      console.error("[executor] failed:", err);
    }
  },
  // No fetch handler. That is the point of this Worker.
};
