-- Replaces the measurement trigger, which schema.sql cannot do.
--
-- It was created with `create trigger if not exists`, so correcting it
-- in schema.sql changed nothing on a database that already had the old
-- one. The old one read `plazo_dias`, left over from when this project
-- was written in Spanish, while the analyst's tool schema returns
-- `days`. The condition never matched, so `measure_on` was null on every
-- row ever inserted.
--
-- Rows inserted before this keep their null: the trigger only fires on
-- insert, and back-filling would invent a date nobody promised.
--
--   npx wrangler d1 execute meta-ads-agent --remote \
--     -c wrangler.local.jsonc --file migrations/2026-09-21-measure-on-trigger.sql

drop trigger if exists proposals_measure_on;

create trigger proposals_measure_on
after insert on proposals
when new.measure_on is null and json_extract(new.confirms, '$.days') is not null
begin
  update proposals
     set measure_on = date(new.day, '+' || json_extract(new.confirms, '$.days') || ' days')
   where id = new.id;
end;
