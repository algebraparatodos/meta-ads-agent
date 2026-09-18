/**
 * The one call to a language model in this project.
 *
 * Called at most once a day, after the deterministic checks have run and
 * only if the snapshot is usable. It is given a summary with the
 * arithmetic already done and must answer through a forced tool, so the
 * shape of what comes back is guaranteed and the measurement it promises
 * is machine readable.
 *
 * Prompt caching is deliberately off. The cache costs 1.25x to write and
 * 0.1x to read, with a five minute life; runs here are a day apart, so
 * the write would be paid every time and the discount never collected.
 * That is a 25% surcharge on every run in exchange for nothing.
 */

import Anthropic from "@anthropic-ai/sdk";

import type { Config } from "../config.ts";
import { HAIKU, estimateTokens, maySpend, readBudget, recordSpend } from "./budget.ts";
import { SYSTEM, TOOL } from "./playbook.ts";

/** Cheap by default. Anything running unattended should be. */
export const MODEL = "claude-haiku-4-5";
const MAX_OUTPUT = 2000;

export type Proposed = {
  kind: string;
  brand_id?: string;
  ref_type: "campaign" | "adset" | "ad";
  ref_id: string;
  ref_name: string;
  title: string;
  observed: string;
  hypothesis: string;
  change: string;
  confirms: {
    metric: string;
    on: string;
    on_id: string;
    direction: "up" | "down";
    threshold: number;
    days: number;
  };
  falsified_by: string;
  cost_if_wrong: string;
  reversible: boolean;
  confidence: "high" | "medium" | "low";
  risk?: string | null;
};

export type AnalystResult =
  | { ran: true; proposals: Proposed[]; costEur: number; note: string }
  | { ran: false; why: string };

export async function analyse(
  summary: string,
  config: Config,
  day: string,
  db: D1Database,
  apiKey: string,
): Promise<AnalystResult> {
  if (!apiKey) return { ran: false, why: "no Anthropic key configured" };

  const estimated = estimateTokens(SYSTEM) + estimateTokens(summary) + 600;
  const budget = await readBudget(db, day, config.budget.dailyEur, config.budget.monthlyEur);
  const verdict = maySpend(budget, estimated, MAX_OUTPUT);

  if (!verdict.allowed) {
    // Not an error. The checks have already run and their proposals are
    // already queued; what stops here is the judgement half.
    return { ran: false, why: verdict.reason };
  }

  const asked = await askModel(summary, apiKey);
  if (!asked.ok) return { ran: false, why: asked.why };

  // Recorded before anything else is done with the answer: a response
  // that arrives and then fails to parse still cost money.
  const costEur = await recordSpend(db, day, "analyst", MODEL, asked.usage, HAIKU);

  const answer = asked.answer;
  if (!answer) {
    return { ran: false, why: `no tool call in the answer (cost ${costEur.toFixed(4)} EUR)` };
  }

  if (answer.nothing_to_propose) {
    return {
      ran: true,
      proposals: [],
      costEur,
      note: answer.why_nothing ?? "nothing worth proposing today",
    };
  }

  const proposals = (answer.proposals ?? []).filter(isUsable);

  return {
    ran: true,
    proposals,
    costEur,
    note: `${proposals.length} proposals, ${(answer.proposals ?? []).length - proposals.length} discarded as unusable`,
  };
}

export type Answer = {
  nothing_to_propose?: boolean;
  why_nothing?: string | null;
  proposals?: Proposed[];
};

export type Asked =
  | { ok: true; answer: Answer | null; usage: { input_tokens?: number; output_tokens?: number } }
  | { ok: false; why: string };

/**
 * The call itself, with no database and no bookkeeping.
 *
 * Split out so the dry run can make it against a real account without a
 * database to write to. Nothing decides here: the caller still has to
 * check the budget first and record the cost afterwards.
 */
export async function askModel(summary: string, apiKey: string): Promise<Asked> {
  const claude = new Anthropic({ apiKey });

  try {
    const response = await claude.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [{ role: "user", content: summary }],
    });

    const block = response.content.find((part) => part.type === "tool_use");
    return {
      ok: true,
      answer: block && block.type === "tool_use" ? (block.input as Answer) : null,
      usage: response.usage,
    };
  } catch (err) {
    return { ok: false, why: `call failed: ${String(err).slice(0, 200)}` };
  }
}

/** Exported so the dry run applies exactly the same filter. */
export { isUsable };

/**
 * Throws away answers that cannot be acted on or measured.
 *
 * The schema makes the fields present; it cannot make them meaningful. A
 * proposal with no figure in what it observed, or promising to measure
 * something over zero days, is one nobody can check later, which is the
 * one thing this design refuses to send.
 */
function isUsable(proposal: Proposed): boolean {
  if (!proposal.ref_id || !proposal.title || !proposal.change) return false;
  if (!proposal.confirms?.metric || !proposal.confirms.on_id) return false;
  if (!(proposal.confirms.days > 0)) return false;
  if (!(proposal.confirms.threshold > 0)) return false;
  // Something that cites no number is an opinion, and opinions do not
  // earn a place in a daily email.
  if (!/\d/.test(proposal.observed)) return false;
  return true;
}
