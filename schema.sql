-- Schema for Cloudflare D1.
--
-- Two rules shape it, and both come from what this thing is for.
--
-- 1. Nothing account specific is hardcoded anywhere in src/. Which ad
--    account, which pixels, which brands and which thresholds all live
--    in `settings` and `brands`, so the same code runs for anyone.
--
-- 2. Every proposal keeps the numbers it was decided on, in `baseline`.
--    Meta's own reporting moves backwards for the last few hours, so
--    comparing today's figure against today's figure a week later does
--    not measure the change, it measures the reporting.

-- ---------------------------------------------------------------- setup

create table if not exists settings (
  key        text primary key,
  value      text not null,              -- JSON
  updated_at text not null default (datetime('now'))
);

-- One row per business sharing the ad account. Meta has no field for
-- this: an account holding two brands tells them apart by a prefix in
-- the campaign name, which is a convention, not a guarantee. Anything
-- that cannot be attributed raises a check rather than being guessed.
create table if not exists brands (
  id             text primary key,       -- 'northside'
  display_name   text not null,          -- 'Northside Pottery'
  campaign_prefix text not null,         -- 'NORTH'
  pixel_id       text not null,
  domain         text,                   -- expected conversion_domain
  -- JSON, only the fields that differ from the account's. Two brands on
  -- one account are two businesses, and a cost per lead that is a
  -- disaster for one is normal for the other.
  thresholds     text,
  notes          text
);

-- ------------------------------------------------------------ snapshots

create table if not exists snapshots (
  day      text primary key,             -- account timezone, YYYY-MM-DD
  taken_at text not null default (datetime('now')),
  complete integer not null default 0,   -- 0 blocks the LLM half
  missing  text not null default '[]',   -- JSON array of failed calls
  calls    integer not null default 0,
  data     text not null                 -- JSON
);

-- The one read this project cannot make with a read-only token.
-- `GET /{pixel}/stats` requires ads_management, and no other endpoint
-- returns the same numbers, so the executor Worker fetches them with the
-- wide token it already holds and leaves them here. The agent reads this
-- table instead of asking Meta, and therefore never needs a token that
-- could spend money. Figures are as old as the last executor run, which
-- is fine for event match quality and would not be for anything
-- answering "is this arriving right now".
create table if not exists pixel_stats (
  pixel_id text primary key,
  read_at  text not null,
  events   text not null default '[]',    -- JSON
  matching text not null default '[]'     -- JSON
);

-- ------------------------------------------------------------ proposals

create table if not exists proposals (
  id         integer primary key autoincrement,
  code       text unique,                -- 'ADS-0142', derived from id
  created_at text not null default (datetime('now')),
  day        text not null,
  brand_id   text,                       -- null when it spans the account
  source     text not null check (source in ('check', 'llm')),
  kind       text not null,              -- audience, copy, creative, budget...

  ref_type   text not null check (ref_type in ('campaign','adset','ad','pixel','site')),
  ref_id     text not null,
  ref_name   text,

  title      text not null,              -- the email subject
  observed   text not null,              -- what was seen, with the figure
  hypothesis text,
  change     text not null,              -- what to do, concrete
  action     text,                       -- JSON the executor understands

  -- What would prove it right. Machine readable on purpose: as free text
  -- nobody can recompute it later and the loop never closes.
  confirms   text,                       -- JSON
  falsifies  text,
  cost_if_wrong text,
  reversible integer not null default 1,
  confidence text check (confidence in ('high','medium','low')),
  risk       text,

  baseline   text not null default '{}', -- the figures it was decided on

  state      text not null default 'proposed'
    check (state in ('proposed','approved','rejected','applied','measured','expired','failed')),
  state_at   text not null default (datetime('now')),
  decided_by text check (decided_by in ('email','link','chat','panel','clock')),
  comment    text,
  applied_at text,

  measure_on text,
  outcome    text check (outcome in ('confirmed','refuted','no_data')),
  outcome_detail text,
  measured_at text,

  -- sha256(brand|kind|ref_id|normalised change). The unique index below
  -- is what stops the same proposal arriving every morning.
  fingerprint text not null,
  message_id  text
);

-- The short code people quote: ADS-0001.
--
-- A trigger rather than something the application writes, so there is
-- one source for it and it cannot be forgotten by a new caller. It is
-- derived from the row id, which SQLite already guarantees is unique and
-- never reused, so no separate counter can drift out of step with it.
create trigger if not exists proposals_code
after insert on proposals
when new.code is null
begin
  update proposals set code = 'ADS-' || printf('%04d', new.id) where id = new.id;
end;

-- Measurement date, from the plazo the proposal set for itself. Same
-- reasoning: whoever inserts should not have to remember to compute it.
create trigger if not exists proposals_measure_on
after insert on proposals
when new.measure_on is null and json_extract(new.confirms, '$.plazo_dias') is not null
begin
  update proposals
     set measure_on = date(new.day, '+' || json_extract(new.confirms, '$.plazo_dias') || ' days')
   where id = new.id;
end;

create unique index if not exists proposals_open_fingerprint
  on proposals (fingerprint)
  where state in ('proposed', 'approved', 'applied');

create index if not exists proposals_open on proposals (state, created_at);
create index if not exists proposals_to_measure on proposals (measure_on) where state = 'applied';

-- One click approval links. Only the hash is stored: a link that leaks
-- from a mailbox should not be replayable from the database.
create table if not exists approvals (
  token_hash  text primary key,
  proposal_id integer not null references proposals(id) on delete cascade,
  action      text not null check (action in ('approve', 'reject')),
  expires_at  text not null,
  used_at     text
);

-- ------------------------------------------------------------ execution

-- Written by the executor Worker, which is the only thing in this
-- project that writes to Meta. `readback` is not bookkeeping: Meta
-- answers `{"success": true}` to edits it silently ignores, so an action
-- is not done until the object has been read again and matched.
create table if not exists executions (
  id          integer primary key autoincrement,
  proposal_id integer not null references proposals(id),
  started_at  text not null default (datetime('now')),
  finished_at text,
  status      text not null default 'running'
    check (status in ('running','done','mismatch','failed')),
  request     text not null,             -- JSON sent to the Graph API
  response    text,                      -- JSON Meta answered
  readback    text,                      -- JSON of the object read after
  undo        text,                      -- JSON: how to put it back
  error       text
);

create index if not exists executions_by_proposal on executions (proposal_id);

-- ---------------------------------------------------------------- money

-- The counter claude-budget writes to. Kept separate from ai_usage on
-- purpose: this one is a cap that must be cheap to read and write, that
-- one is a ledger nobody reads in the request path.
create table if not exists ai_spend (
  key        text primary key,
  micros     integer not null default 0,
  expires_at text not null
);

create table if not exists ai_usage (
  id           integer primary key autoincrement,
  created_at   text not null default (datetime('now')),
  day          text not null,
  tool         text not null,
  model        text not null,
  input_tokens integer,
  output_tokens integer,
  cache_write_tokens integer,
  cache_read_tokens  integer,
  cost_usd     real not null,
  cost_eur     real not null
);

create index if not exists ai_usage_by_day on ai_usage (day);

-- --------------------------------------------------------------- alerts

-- Stops the same alert going out twice. The primary key does the work,
-- not the clock: a second run inserting the same pair simply fails.
create table if not exists notices (
  kind    text not null,
  ref     text not null,
  sent_at text not null default (datetime('now')),
  primary key (kind, ref)
);
