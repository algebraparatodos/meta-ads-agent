/**
 * The one-click approve and discard links.
 *
 * A random token stored as its own hash, rather than something signed
 * that the server can recompute. Three reasons, and the third is the one
 * that matters:
 *
 * - It can be revoked. A signature is valid until the key changes.
 * - It is single use, which a signature cannot be without storage
 *   anyway, so the storage was going to exist regardless.
 * - **Only the hash is kept.** A link that leaks out of a mailbox, or
 *   sits in a log line, cannot be found by reading the database, and
 *   whoever reads the database cannot mint one.
 */

const TOKEN_BYTES = 24;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

export type DecisionLinks = { approve: string; reject: string };

/**
 * Makes one link per decision and records what each one is for.
 *
 * They expire with the proposal, not later: a link that still works
 * after the proposal went stale would apply a diagnosis made against
 * numbers that no longer exist, which is exactly what expiry is for.
 */
export async function createDecisionLinks(
  db: D1Database,
  proposalId: number,
  publicUrl: string,
  ttlDays: number,
): Promise<DecisionLinks> {
  const links: Partial<DecisionLinks> = {};

  for (const action of ["approve", "reject"] as const) {
    const token = toHex(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
    await db
      .prepare(
        `insert into approvals (token_hash, proposal_id, action, expires_at)
         values (?, ?, ?, datetime('now', ?))`,
      )
      .bind(await hash(token), proposalId, action, `+${ttlDays} days`)
      .run();
    links[action] = `${publicUrl.replace(/\/$/, "")}/d/${token}`;
  }

  return links as DecisionLinks;
}

export type Redemption =
  | { ok: true; proposalId: number; action: "approve" | "reject" }
  | { ok: false; reason: "unknown" | "expired" | "used" | "already_decided" };

/**
 * Spends a link, once.
 *
 * The update is the check: asking whether the token is unused and then
 * marking it used are the same statement, so two clicks arriving
 * together cannot both win. Doing it as a read and then a write is the
 * version that looks correct and is not.
 */
export async function redeem(db: D1Database, token: string): Promise<Redemption> {
  const row = await db
    .prepare(
      `select proposal_id, action, expires_at, used_at
         from approvals where token_hash = ?`,
    )
    .bind(await hash(token))
    .first<{ proposal_id: number; action: string; expires_at: string; used_at: string | null }>();

  if (!row) return { ok: false, reason: "unknown" };
  if (row.used_at) return { ok: false, reason: "used" };

  const claimed = await db
    .prepare(
      `update approvals set used_at = datetime('now')
        where token_hash = ? and used_at is null and expires_at > datetime('now')`,
    )
    .bind(await hash(token))
    .run();

  if ((claimed.meta.changes ?? 0) === 0) {
    return { ok: false, reason: "expired" };
  }

  return {
    ok: true,
    proposalId: row.proposal_id,
    action: row.action === "approve" ? "approve" : "reject",
  };
}

/**
 * Records the decision on the proposal itself.
 *
 * Refuses to move anything that is not still waiting. A proposal already
 * approved, rejected or expired has had its moment, and a second
 * decision arriving late must not quietly overwrite the first.
 */
export async function decide(
  db: D1Database,
  proposalId: number,
  action: "approve" | "reject",
  by: "email" | "link" | "chat" | "panel",
  comment: string | null = null,
): Promise<boolean> {
  const result = await db
    .prepare(
      `update proposals
          set state = ?, state_at = datetime('now'), decided_by = ?, comment = ?
        where id = ? and state = 'proposed'`,
    )
    .bind(action === "approve" ? "approved" : "rejected", by, comment, proposalId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}
