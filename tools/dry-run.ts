/**
 * Runs the agent against a real ad account and prints what it would say.
 *
 * Nothing is written anywhere: no database, no email, no call to Meta
 * that is not a GET. It exists so the checks can be aimed at a real
 * account before any of this is deployed, which is the only way to find
 * out that a rule fires on something that was never broken.
 *
 * That is not hypothetical. The first version of the pixel check would
 * have reported four healthy sales ads as unmeasured, because it only
 * knew one of the three ways Meta attaches a pixel. Nothing but a real
 * account would have shown that.
 *
 * Usage:
 *
 *   export META_ADS_TOKEN_READ=...
 *   node tools/dry-run.ts path/to/local-config.json
 *
 * The config file is the same shape the database holds. Keep it out of
 * the repository: `local-config.json` is already in .gitignore.
 */

import { MetaClient } from "../src/meta/client.ts";
import { takeSnapshot } from "../src/meta/snapshot.ts";
import { runChecks } from "../src/checks/run.ts";
import { toProposals } from "../src/queue/proposals.ts";
import { compose, replyAddress } from "../src/mail/compose.ts";
import { DEFAULT_THRESHOLDS, type Config } from "../src/config.ts";
import { today } from "../src/dates.ts";
import { readFileSync } from "node:fs";

function loadLocalConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const account = (raw.account ?? {}) as Record<string, unknown>;
  const brands = Array.isArray(raw.brands) ? raw.brands : [];

  return {
    enabled: true,
    accountId: String(account.id ?? "").startsWith("act_")
      ? String(account.id)
      : `act_${String(account.id ?? "")}`,
    timeZone: String(account.timeZone ?? "UTC"),
    currency: String(account.currency ?? "EUR"),
    brands: brands as Config["brands"],
    retiredPixels: (Array.isArray(raw.retiredPixels) ? raw.retiredPixels : []) as Config["retiredPixels"],
    customerAreas: (Array.isArray(raw.customerAreas) ? raw.customerAreas : []) as string[],
    thresholds: { ...DEFAULT_THRESHOLDS, ...((raw.thresholds ?? {}) as object) },
    notify: {
      to: String((raw.notify as Record<string, unknown>)?.to ?? "you@example.com"),
      from: String((raw.notify as Record<string, unknown>)?.from ?? "Ads <ads@example.com>"),
      replyDomain: String((raw.notify as Record<string, unknown>)?.replyDomain ?? "example.com"),
      approvers: [],
    },
    budget: { dailyEur: 0, monthlyEur: 0 },
    // The real cap, not a dry-run one: seeing which proposals would have
    // waited until tomorrow is part of what this tool is for.
    maxProposalsPerDay: Number(raw.maxProposalsPerDay ?? 3),
    proposalTtlDays: 7,
  };
}

const configPath = process.argv[2] ?? "local-config.json";
// Deliberately no fallback to a wider token. Meta will not let you take
// ads_management away from a token that already has it, so the only way
// to have a read-only one is to create it separately, and the only way
// to be sure it is the one in use is to refuse to run without it.
const token = process.env.META_ADS_TOKEN_READ;

if (!token) {
  console.error("Set META_ADS_TOKEN_READ to a token holding ads_read and nothing else.");
  console.error("Check what a token actually carries before trusting it:");
  console.error("  GET /debug_token?input_token=<token>&access_token=<token>");
  process.exit(1);
}

const config = loadLocalConfig(configPath);
const client = new MetaClient({ token, accountId: config.accountId });
const day = today(config.timeZone);

console.log(`Account ${config.accountId}, ${day} in ${config.timeZone}`);
console.log(`Brands: ${config.brands.map((b) => `${b.displayName} (${b.campaignPrefix})`).join(", ")}`);
console.log();

const result = await takeSnapshot(client, config, day);

console.log(
  `Snapshot: ${result.calls} calls, usable for analysis: ${result.complete}`,
);
if (result.missing.length > 0) {
  console.log(`  failed calls: ${result.missing.join(", ")}`);
  if (result.complete) {
    console.log("  none of them essential, so the checks below still hold");
  }
}
console.log(
  `  ${result.snapshot.campaigns.length} campaigns, ` +
    `${result.snapshot.adSets.length} live ad sets, ` +
    `${result.snapshot.ads.length} live ads, ` +
    `${result.snapshot.conversions.length} custom conversions`,
);
console.log();

const findings = runChecks(result.snapshot, config);

if (findings.length === 0) {
  console.log("No findings. Either the account is in good shape or the checks are asleep.");
} else {
  const urgent = findings.filter((f) => f.severity === "urgent");
  console.log(`${findings.length} findings, ${urgent.length} urgent:`);
  console.log();
  for (const finding of findings) {
    const mark = finding.severity === "urgent" ? "!!" : "  ";
    console.log(`${mark} [${finding.id}] ${finding.title}`);
  }
}

// What actually reaches the inbox is not the finding list: repeats are
// collapsed, and only the first few go out on any one day.
const proposals = await toProposals(findings, day);
console.log();
console.log(`After grouping: ${proposals.length} proposals from ${findings.length} findings`);
console.log();
for (const [index, proposal] of proposals.entries()) {
  const first = index < config.maxProposalsPerDay ? "TODAY " : "queued";
  console.log(`  ${first}  ${proposal.title}`);
}

const first = proposals[0];
if (first) {
  const stored = { ...first, id: 1, code: "ADS-0001", state: "proposed" };
  const links = {
    approve: "https://ads.example.com/d/<signed>",
    reject: "https://ads.example.com/d/<signed>",
  };
  const email = compose(stored, config, links);
  console.log();
  console.log("=".repeat(70));
  console.log(`Subject:  ${email.subject}`);
  console.log(`Reply-To: ${replyAddress("ADS-0001", config.notify.replyDomain)}`);
  console.log("=".repeat(70));
  console.log(email.text);
  console.log("=".repeat(70));
}
