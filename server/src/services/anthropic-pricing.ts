import { centsToUsd, unitsToCents, usdToUnits } from "@paperclipai/shared";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";

// Direct Anthropic API list prices.
// https://platform.claude.com/docs/en/about-claude/pricing
// Qualified model ids only. Aliases, dated snapshots, and other billers stay unknown.
// Rates are USD per million tokens: uncached input, cache read, one-hour cache write, output.
// Output is the provider total. Anthropic includes thinking tokens in output_tokens,
// so a separate reasoning counter is not added.
const CARDS = {
  "claude-sonnet-5": {
    // Verified 2026-10-07.
    rates: ["2", "0.2", "4", "10"],
    version: "anthropic-standard-2026-10-07",
    inputCentsPerMillion: "200",
    cachedInputCentsPerMillion: "20",
    cacheWriteCentsPerMillion: "400",
    outputCentsPerMillion: "1000",
    evidence: "https://platform.claude.com/docs/en/about-claude/pricing; standard global API pricing assumed; cache-write TTL unavailable, one-hour upper rate used; not an invoice",
  },
  "claude-haiku-4-5": {
    // Verified 2026-11-07. Haiku 4.5 list: $1 input, $5 output, $0.10 cache read,
    // $1.25 five-minute cache write, $2 one-hour cache write.
    rates: ["1", "0.1", "2", "5"],
    version: "anthropic-haiku-4-5-2026-11-07",
    inputCentsPerMillion: "100",
    cachedInputCentsPerMillion: "10",
    cacheWriteCentsPerMillion: "200",
    outputCentsPerMillion: "500",
    evidence: "https://platform.claude.com/docs/en/about-claude/pricing verified 2026-11-07; Claude Haiku 4.5 standard global list $1/MTok input, $5/MTok output, $0.10/MTok cache read; cache-write TTL unavailable, one-hour upper rate $2/MTok used (five-minute write is $1.25); output total includes thinking when the provider includes it; not an invoice",
  },
} as const;

/** A complete token receipt can receive an explicit estimate, never an invoice
 * claim. ACP aggregates cache writes without TTL; conservatively price them at
 * the documented one-hour rate rather than silently assume five-minute writes.
 * Missing cache counters stay unpriced. An explicit zero is a real counter. */
export function priceAnthropicReceipt(receipt: AdapterUsageCheckpoint): AdapterUsageCheckpoint {
  const card = typeof receipt.model === "string" ? CARDS[receipt.model as keyof typeof CARDS] : undefined;
  if (!card || !receipt.complete || !receipt.usage || receipt.usageBasis !== "per_run"
    || receipt.provider !== "anthropic" || receipt.biller !== "anthropic"
    || !["api", "metered_api"].includes(receipt.billingType ?? "")
    || receipt.usageByModel?.length
    || receipt.costUsd != null || receipt.costUsdExact != null || receipt.cacheAdjustedCostUsd != null
    || (receipt.pricingContext?.serviceTier && !["standard", "default"].includes(receipt.pricingContext.serviceTier))) return receipt;
  const usage = receipt.usage;
  if (usage.cacheWriteTokens === undefined || usage.cachedInputTokens === undefined) return receipt;
  const counts = [usage.inputTokens - usage.cacheWriteTokens, usage.cachedInputTokens, usage.cacheWriteTokens, usage.outputTokens];
  if (counts.some(count => !Number.isSafeInteger(count) || count < 0)) return receipt;
  const numerator = counts.reduce((total, count, index) => total + BigInt(count) * usdToUnits(card.rates[index]), 0n);
  return { ...receipt, costUsdExact: centsToUsd(unitsToCents((numerator + 500_000n) / 1_000_000n)), costStatus: "estimated",
    pricingProvenance: {
      source: "rate_card", version: card.version, evidence: card.evidence,
      inputCentsPerMillion: card.inputCentsPerMillion, cachedInputCentsPerMillion: card.cachedInputCentsPerMillion,
      cacheWriteCentsPerMillion: card.cacheWriteCentsPerMillion, outputCentsPerMillion: card.outputCentsPerMillion,
      serviceTier: "standard",
    },
  };
}
