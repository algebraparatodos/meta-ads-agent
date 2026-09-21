-- Lets an approval link carry a third meaning: this one has been done.
--
-- `schema.sql` is written with `create table if not exists`, so it
-- cannot change a table that already exists anywhere. SQLite cannot
-- alter a check constraint either, so the table is rebuilt. The 58 rows
-- of live links are copied across: a link that is still in somebody's
-- inbox has to keep working across this.
--
--   npx wrangler d1 execute meta-ads-agent --remote \
--     -c wrangler.local.jsonc --file migrations/2026-09-21-done-links.sql

alter table approvals rename to approvals_old;

create table approvals (
  token_hash  text primary key,
  proposal_id integer not null references proposals(id) on delete cascade,
  action      text not null check (action in ('approve', 'reject', 'done')),
  expires_at  text not null,
  used_at     text
);

insert into approvals (token_hash, proposal_id, action, expires_at, used_at)
  select token_hash, proposal_id, action, expires_at, used_at from approvals_old;

drop table approvals_old;
