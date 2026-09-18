# meta-ads-agent

Watches a Meta ad account every morning, finds what is quietly broken,
and emails you one proposal at a time. You approve by replying or by
clicking a link. Nothing is changed until you do.

Runs on Cloudflare Workers with D1. No servers, no dashboard to log into,
and the whole thing costs a few cents a month.

```
Snapshot: 12 calls, usable for analysis: true
  17 campaigns, 4 live ad sets, 23 live ads, 34 custom conversions
15 findings, 0 urgent
After grouping: 7 proposals from 15 findings
  → 3 emailed, 4 queued for tomorrow
```

## Why it exists

Meta will tell you what an ad cost. It will not tell you that the ad has
been running for two weeks with no pixel attached, or that its headline
is being cropped off in the placement that sells best, or that the
"purchase" event it is optimising for fires on a free trial.

All three of those are visible in the API the same day they start. None
of them raises an error, appears in a dashboard, or stops delivery. The
campaign keeps running and the report keeps looking plausible, which is
the worst possible combination: you act on it.

## The part worth stealing

**Two Workers, and only one of them can spend money.**

```
   ┌─ meta-ads-agent ──────────────────┐   token: ads_read only
   │  cron + fetch                     │
   │  the panel, the approval links,   │
   │  the inbound email webhook        │
   │  reads the account, cannot spend  │
   └───────────────┬───────────────────┘
                   │  shared D1 database
   ┌───────────────┴───────────────────┐
   │  meta-ads-executor                │   token: ads_management
   │  cron only, NO fetch handler      │
   │  no address on the internet       │
   └───────────────────────────────────┘
```

Meta's ads token is all-or-nothing in a way that matters: once a token
carries `ads_management` you cannot take it away, and `ads_management`
can create campaigns and spend money. The usual answer is to be careful.

This is the other answer. The half that faces the internet holds a token
scoped to `ads_read`, so an attacker who owns it completely still cannot
spend a euro. The half that can spend has no `fetch` handler at all, so
there is nothing to attack: it wakes on a timer, reads approvals already
written to the database, and goes back to sleep.

Verified rather than assumed, which is the point:

```
GET /debug_token → scopes: ads_read, public_profile
POST /{archived_ad}  name=<its own current name>  → 400, rejected
```

## What it checks

Twenty rules, none of which need a language model. Every expensive
mistake in this domain is deterministic: a field that is empty, a pixel
id belonging to the other brand, a string holding a replacement
character. Sending that to a model would be slower, more expensive and
less reliable, and it would stop working on the day the budget runs out,
which is the day you most want it working.

**Measurement** — can these numbers be believed at all
- An ad running with no pixel attached to its conversions
- An ad reporting to a different brand's pixel
- `conversion_domain` empty, or not matching where the ad actually links
- An ad still pointing at a pixel the account retired
- An ad set bidding on a custom conversion whose dataset cannot be resolved
- Too many events reaching Meta with nothing to match a person on
- Pixel settings quietly costing match rate
- Custom conversions defined by what they exclude, which expire silently

**Creative** — what the ad actually shows somebody
- Text that reached Meta as broken bytes and cannot be recovered
- Vertical artwork being cropped through its own headline in the feed
- Copy using characters that break in transit (off by default)

**Audience** — who it is shown to
- A retargeting audience quietly collecting people who already bought
- A sales or lead ad set that excludes nobody

**Delivery** — what the account is doing with the money
- The account stopped by Meta rather than by a person
- Money going out with no results at all
- One ad taking the budget and converting nothing while a sibling converts
- Frequency, and fatigue measured as CTR falling *and* CPM rising together
- An ad set bidding on an event it will never get enough of to finish learning
- Attribution or budget-sharing set to something nobody chose

Every threshold is configuration, not code, and can differ per brand.
Two businesses sharing one ad account are two businesses: a cost per lead
that is a disaster for one is normal for the other.

## What it does not do

- **It does not change anything on its own.** Ever.
- **It does not guess.** "Cannot tell which pixel this uses" is reported
  as its own finding, separately from "has no pixel", because the two
  call for opposite actions and one of them might turn out to be fine.
- **It does not email you on a quiet day.** Silence is what makes the
  other days worth opening.

## Design notes

A few decisions that cost something to learn.

**One picture a day, stored whole.** Walking an account object by object
once left it answering `(#17) User request limit reached` to everything,
including reading back an ad that had just been created. Collection and
analysis are separate: twelve calls once a day, saved, and every check
reads the saved copy.

**"Complete" means "everything essential arrived", not "nothing
failed".** If the ads call fails, an ad set looks like it has no ads and
the obvious suggestion is to turn it on — that is false information and
it stops the analysis. If a pixel stats call fails, two checks have
nothing to say and the rest is still true. Conflating those two once
skipped a whole run over perfectly good data.

**Repeats are grouped from three.** Nine ads with the same problem is one
decision, not nine, and sending it as nine fills the day's quota with a
single issue. Two still go separately: at that size the detail is worth
more than the tidiness.

**The proposal code travels in the reply address, not the subject.**
Subjects get edited, translated and prefixed with `Re:` and `Fwd:`. The
envelope recipient survives all of it.

**Approval links are random tokens stored only as their hash**, single
use, expiring with the proposal. A link that leaks out of a mailbox
cannot be found by reading the database, and whoever reads the database
cannot mint one. Clicking opens a confirmation page rather than deciding
on the GET, because mail scanners follow links before a person sees them.

**Proposals expire after a week.** Not tidiness: an approval given three
weeks late applies a diagnosis made against numbers that no longer exist.

## Setup

```bash
npm install
npx wrangler d1 create meta-ads-agent      # put the id in wrangler.local.jsonc

cp examples/config.example.json local-config.json   # then edit it
npm run db:remote                                   # schema
node tools/config-sql.ts local-config.json > config.local.sql
npx wrangler d1 execute meta-ads-agent -c wrangler.local.jsonc \
  --remote --file config.local.sql

npx wrangler secret put META_ADS_TOKEN_READ   # ads_read ONLY. Check it first.
npx wrangler secret put RESEND_API_KEY
npm run deploy
```

Before trusting any token, ask Meta what it actually carries:

```
GET /debug_token?input_token=<token>&access_token=<token>
```

If `scopes` contains `ads_management`, `business_management` or
`pages_manage_ads`, that token can spend money and does not belong in the
internet-facing Worker. Meta will not let you narrow an existing token;
you have to create a separate system user.

### Try it without deploying anything

```bash
export META_ADS_TOKEN_READ=...
node tools/dry-run.ts local-config.json
```

Reads the account, runs every check, groups the findings and prints the
email it would have sent. No database, no sending, no writes of any kind.

This is worth doing first, and not only to see it work. Aimed at a real
account, the first version of the pixel check reported four perfectly
healthy ads as unmeasured: their ad set carried a `custom_conversion_id`
rather than a `pixel_id`, and Meta resolves the pixel from that. Nothing
but a real account would have shown it. There is a regression test for
that exact shape in `test/pixel-routing.test.ts`.

## Tests

```bash
npm test          # node --test, no framework
npm run typecheck
```

## Notes on the Graph API

Things that cost an afternoon each.

- Reading a custom conversion's dataset is `data_sources`. The write-side
  name `event_source_id` returns a 400 when read, and asking for it in
  the account-wide listing does not fail at all: it returns empty on
  every row, so it looks like no conversion has a pixel.
- `GET /{pixel}/stats` requires `ads_management`. Not a permission on the
  asset — a system user with `ADVERTISE, UPLOAD, ANALYZE` on the pixel
  still gets `(#100) Permission Denied` with an `ads_read` token, and
  there is no other endpoint that returns the same numbers.
- `/stats` nests one array inside another, one entry per time bucket.
  Reading only the first gives you an hour and makes a busy pixel look
  dead.
- The default `/stats` aggregation is a rolling window that can return a
  smaller number than it did ten minutes ago. Use `event_total_counts`.
- `estimate_dau` in `delivery_estimate` is deprecated and fails the whole
  call with `(#12)`.
- Listing campaigns without `effective_status` returns only live ones. On
  a mature account that is a small fraction of the history.
- SQLite, not Meta, but adjacent: `ON CONFLICT` against a *partial*
  unique index must repeat the index's `WHERE` clause. Without it the
  error says the constraint does not exist.

## Licence

MIT.
