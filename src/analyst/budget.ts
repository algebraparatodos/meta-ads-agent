/**
 * The spending cap, in euros, on the only part of this that costs money
 * per run.
 *
 * Two belts, because they stop different things.
 *
 * The **daily** cap stops a bug. Something that loops, or a prompt that
 * grew by an order of magnitude, burns through a monthly budget in
 * minutes, and a monthly check would notice on the way past. Sized at a
 * few times one normal run, so it never fires in normal use and always
 * fires before it matters.
 *
 * The **monthly** cap is the number that was actually agreed. When it is
 * reached the model half stops and the deterministic checks keep running,
 * which is the right way round: the cheap half is also the half that
 * finds the expensive problems.
 *
 * Pricing is checked before the call, not after. A call whose cost is
 * only known once it has been made cannot be prevented by knowing it.
 */

/** Per million tokens, in US dollars. */
export type Pricing = { input: number; output: number };

/**
 * Haiku, the cheap model, which is the default for anything that runs on
 * its own. A model choice for a job like this should be justifiable out
 * loud; "it is the one that was in the example" is not a justification.
 */
export const HAIKU: Pricing = { input: 1, output: 5 };

const USD_TO_EUR = 0.92;

export function priceOf(
  inputTokens: number,
  outputTokens: number,
  pricing: Pricing = HAIKU,
): { usd: number; eur: number } {
  const usd =
    (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  return { usd, eur: usd * USD_TO_EUR };
}

export type BudgetState = {
  spentTodayEur: number;
  spentThisMonthEur: number;
  dailyCapEur: number;
  monthlyCapEur: number;
};

export async function readBudget(
  db: D1Database,
  day: string,
  dailyCapEur: number,
  monthlyCapEur: number,
): Promise<BudgetState> {
  const month = day.slice(0, 7);
  const row = await db
    .prepare(
      `select
         coalesce(sum(case when day = ? then cost_eur else 0 end), 0) as today,
         coalesce(sum(cost_eur), 0) as month
       from ai_usage where day like ?`,
    )
    .bind(day, `${month}%`)
    .first<{ today: number; month: number }>();

  return {
    spentTodayEur: Number(row?.today ?? 0),
    spentThisMonthEur: Number(row?.month ?? 0),
    dailyCapEur,
    monthlyCapEur,
  };
}

export type Verdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether a call of roughly this size may be made.
 *
 * The estimate assumes the worst case for output, because a call that
 * would cross the cap only if the model happens to be verbose is a call
 * that crosses the cap eventually. Refusing on the pessimistic figure
 * costs one run; allowing on the optimistic one costs the cap's whole
 * purpose.
 */
export function maySpend(
  state: BudgetState,
  estimatedInputTokens: number,
  maxOutputTokens: number,
  pricing: Pricing = HAIKU,
): Verdict {
  const worst = priceOf(estimatedInputTokens, maxOutputTokens, pricing).eur;

  if (state.spentTodayEur + worst > state.dailyCapEur) {
    return {
      allowed: false,
      reason:
        `daily cap: ${state.spentTodayEur.toFixed(4)} EUR spent today, this call ` +
        `could cost ${worst.toFixed(4)} EUR, cap is ${state.dailyCapEur} EUR`,
    };
  }

  if (state.spentThisMonthEur + worst > state.monthlyCapEur) {
    return {
      allowed: false,
      reason:
        `monthly cap: ${state.spentThisMonthEur.toFixed(2)} EUR spent this month, ` +
        `cap is ${state.monthlyCapEur} EUR`,
    };
  }

  return { allowed: true };
}

/**
 * Records what a call actually cost.
 *
 * Written after every call, including ones that failed partway, because
 * a failed call that consumed input tokens still costs money and a
 * ledger that only counts successes undercounts exactly when something
 * is going wrong.
 */
export async function recordSpend(
  db: D1Database,
  day: string,
  tool: string,
  model: string,
  usage: { input_tokens?: number; output_tokens?: number },
  pricing: Pricing = HAIKU,
): Promise<number> {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const { usd, eur } = priceOf(input, output, pricing);

  await db
    .prepare(
      `insert into ai_usage
         (day, tool, model, input_tokens, output_tokens, cost_usd, cost_eur)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(day, tool, model, input, output, usd, eur)
    .run();

  return eur;
}

/**
 * A rough token count, for deciding before the call whether to make it.
 *
 * Four characters per token is the usual approximation for English and
 * it is close enough for a gate: being wrong by a fifth changes nothing,
 * because the cap is set several times larger than a normal run.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
