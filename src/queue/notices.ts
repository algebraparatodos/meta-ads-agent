/**
 * Emails that are not proposals, and the record that stops them being
 * sent twice.
 *
 * A proposal carries its own guard: it has a `message_id` column, and it
 * is written before it is sent. A message that is about several
 * proposals at once has nowhere to write that, and the daily run can be
 * triggered by hand as often as somebody likes. Without a mark
 * somewhere, a second trigger on the same morning sends the same list
 * again.
 *
 * The mark is written after a successful send and not before, which is
 * the same choice made everywhere else in this project: the failure to
 * avoid is silence, and a duplicate is only a nuisance.
 */

/** Whether this exact message has already gone out. */
export async function noticeSent(
  db: D1Database,
  kind: string,
  ref: string,
): Promise<boolean> {
  const row = await db
    .prepare("select 1 as hit from notices where kind = ? and ref = ?")
    .bind(kind, ref)
    .first<{ hit: number }>();
  return Boolean(row);
}

/** Remembers that it did. `or ignore`, so writing it twice is harmless. */
export async function recordNotice(
  db: D1Database,
  kind: string,
  ref: string,
): Promise<void> {
  await db
    .prepare("insert or ignore into notices (kind, ref) values (?, ?)")
    .bind(kind, ref)
    .run();
}
