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
import { HAIKU, LUNA, estimateTokens, maySpend, readBudget, recordSpend } from "./budget.ts";
import type { Pricing } from "./budget.ts";
import { SYSTEM, TOOL } from "./playbook.ts";

/**
 * Cheap by default. Anything running unattended should be.
 *
 * Since 25/09/2026 the analyst asks OpenAI when there is an OpenAI key and
 * falls back to Anthropic only when there is not. Staying on OpenAI is a
 * cost decision, not a trial: if answers get worse, the fix is made on
 * gpt-6-luna, not by going back to Claude.
 */
export const MODEL = "gpt-6-luna";
const MODEL_ANTHROPIC = "claude-haiku-4-5";
const MAX_OUTPUT = 2000;

/** Which provider answers, and the price the budget has to count it at. */
export type Keys = { openai?: string | undefined; anthropic?: string | undefined };

function provider(keys: Keys): { model: string; pricing: Pricing } | null {
  if (keys.openai) return { model: MODEL, pricing: LUNA };
  if (keys.anthropic) return { model: MODEL_ANTHROPIC, pricing: HAIKU };
  return null;
}

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
  keys: Keys,
): Promise<AnalystResult> {
  const who = provider(keys);
  if (!who) return { ran: false, why: "no model key configured" };

  const estimated = estimateTokens(SYSTEM) + estimateTokens(summary) + 600;
  const budget = await readBudget(db, day, config.budget.dailyEur, config.budget.monthlyEur);
  const verdict = maySpend(budget, estimated, MAX_OUTPUT, who.pricing);

  if (!verdict.allowed) {
    // Not an error. The checks have already run and their proposals are
    // already queued; what stops here is the judgement half.
    return { ran: false, why: verdict.reason };
  }

  const asked = await askModel(summary, keys);
  if (!asked.ok) return { ran: false, why: asked.why };

  // Recorded before anything else is done with the answer: a response
  // that arrives and then fails to parse still cost money.
  const costEur = await recordSpend(db, day, "analyst", who.model, asked.usage, who.pricing);

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
export async function askModel(summary: string, keys: Keys): Promise<Asked> {
  if (keys.openai) return askOpenAI(summary, keys.openai);
  if (!keys.anthropic) return { ok: false, why: "no model key configured" };

  const claude = new Anthropic({ apiKey: keys.anthropic });

  try {
    const response = await claude.messages.create({
      model: MODEL_ANTHROPIC,
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

/**
 * The same call, to OpenAI's Responses API.
 *
 * The tool is still forced, so the answer keeps its guaranteed shape. Two
 * things checked against the API before switching, because either one is
 * a 400 and a 400 here means a day without the judgement half:
 *
 * - no `temperature`: gpt-6-luna rejects it;
 * - not `strict`: strict mode wants every field required, and `risk` and
 *   `brand_id` are not.
 *
 * The usage is translated to the Anthropic field names so the budget code
 * stays provider-agnostic. OpenAI's `input_tokens` already includes the
 * cached part, and it is all counted at the full rate on purpose.
 */
async function askOpenAI(summary: string, apiKey: string): Promise<Asked> {
  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        instructions: SYSTEM,
        input: [{ role: "user", content: summary }],
        tools: [{
          type: "function",
          name: TOOL.name,
          description: TOOL.description,
          parameters: TOOL.input_schema,
          strict: false,
        }],
        tool_choice: { type: "function", name: TOOL.name },
        reasoning: { effort: "low" },
        max_output_tokens: MAX_OUTPUT,
        store: false,
      }),
    });
    if (!res.ok) {
      return { ok: false, why: `call failed: OpenAI ${res.status} ${(await res.text()).slice(0, 180)}` };
    }

    const body = await res.json() as {
      output?: { type: string; name?: string; arguments?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const call = (body.output ?? []).find((o) => o.type === "function_call" && o.name === TOOL.name);
    let answer: Answer | null = null;
    try {
      answer = call?.arguments ? JSON.parse(call.arguments) as Answer : null;
    } catch {
      // Left as null: the caller records the cost and reports "no tool call".
    }

    return {
      ok: true,
      answer,
      usage: { input_tokens: body.usage?.input_tokens ?? 0, output_tokens: body.usage?.output_tokens ?? 0 },
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
