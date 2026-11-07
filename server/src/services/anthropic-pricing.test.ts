import { describe, expect, it } from "vitest";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { priceAnthropicReceipt } from "./anthropic-pricing.js";

const receipt: AdapterUsageCheckpoint = { complete: true, usageBasis: "per_run", provider: "anthropic", biller: "anthropic",
  billingType: "metered_api", model: "claude-sonnet-5", costUsd: null, costStatus: "unpriced",
  usage: { inputTokens: 22462, cachedInputTokens: 208218, cacheWriteTokens: 22450, outputTokens: 2450 } };
const haiku = (usage: AdapterUsageCheckpoint["usage"], model = "claude-haiku-4-5"): AdapterUsageCheckpoint => ({
  complete: true, usageBasis: "per_run", provider: "anthropic", biller: "anthropic", billingType: "metered_api",
  model, costUsd: null, costStatus: "unpriced", usage,
});

describe("complete Anthropic receipt pricing", () => {
  it("prices complete counters conservatively and labels their provenance as an estimate", () => {
    const priced = priceAnthropicReceipt(receipt);
    expect(priced.costUsdExact).toBe("0.155967600");
    expect(priced.costStatus).toBe("estimated");
    expect(priced.pricingProvenance).toMatchObject({ source: "rate_card", version: "anthropic-standard-2026-10-07" });
    expect(priced.pricingProvenance?.evidence).toContain("one-hour upper rate");
    expect(priced.usage).toBe(receipt.usage);
    expect(receipt.costStatus).toBe("unpriced");
  });
  it.each([
    { complete: false }, { billingType: "unknown" }, { billingType: "subscription_included" },
    { provider: "unknown" }, { biller: "aws_bedrock" }, { model: "claude-sonnet-latest" },
    { usageBasis: "session_cumulative" }, { costUsd: 0.12 }, { costUsdExact: "0.12" }, { cacheAdjustedCostUsd: 0.12 },
    { pricingContext: { serviceTier: "priority" } }, { usageByModel: [{ model: "other", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 1 }] },
    { usage: undefined }, { usage: { inputTokens: 1, outputTokens: 1 } },
    { usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 2, cachedInputTokens: 0 } },
  ] as Partial<AdapterUsageCheckpoint>[])("preserves incomplete, incompatible or already priced receipts: %j", override => {
    const original = { ...receipt, ...override };
    expect(priceAnthropicReceipt(original)).toBe(original);
  });

  it.each([
    // Published-list estimate when cache read and cache write are explicit zeros.
    // inputTokens excludes cache reads and includes cache writes.
    [{ inputTokens: 923, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 42 }, "0.001133000"],
    [{ inputTokens: 667, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 31 }, "0.000822000"],
  ] as const)("prices claude-haiku-4-5 from the published list: %j", (usage, costUsdExact) => {
    const priced = priceAnthropicReceipt(haiku(usage));
    expect(priced.costUsdExact).toBe(costUsdExact);
    expect(priced.costStatus).toBe("estimated");
    expect(priced.pricingProvenance).toMatchObject({
      source: "rate_card", version: "anthropic-haiku-4-5-2026-11-07",
      inputCentsPerMillion: "100", cachedInputCentsPerMillion: "10",
      cacheWriteCentsPerMillion: "200", outputCentsPerMillion: "500", serviceTier: "standard",
    });
    expect(priced.pricingProvenance?.evidence).toContain("one-hour upper rate");
    expect(priced.pricingProvenance?.evidence).toContain("$1/MTok input");
  });

  it("prices Haiku cache reads and the one-hour cache-write upper rate, and bills thinking inside output", () => {
    // Same shape normalizeNativeUsage emits: input includes the cache write and excludes the cache read.
    // Output is the provider total, so thinking tokens already inside it are not added again.
    const priced = priceAnthropicReceipt(haiku({ inputTokens: 32, cachedInputTokens: 30, cacheWriteTokens: 20, outputTokens: 4 }));
    expect(priced.costUsdExact).toBe("0.000075000");
    expect(priced.costStatus).toBe("estimated");
  });

  it.each([
    "claude-haiku-4-5-20251001",
    "claude-haiku-4-5-latest",
    "claude-haiku-4.5",
  ])("does not price an unverified Haiku alias: %s", model => {
    const original = haiku({ inputTokens: 923, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 42 }, model);
    expect(priceAnthropicReceipt(original)).toBe(original);
  });

  it("keeps a Haiku receipt unpriced when cache counters are missing or inconsistent", () => {
    const missing = haiku({ inputTokens: 923, outputTokens: 42 });
    const writeAboveInput = haiku({ inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 11, outputTokens: 1 });
    const priority = { ...haiku({ inputTokens: 923, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 42 }), pricingContext: { serviceTier: "priority" } };
    expect(priceAnthropicReceipt(missing)).toBe(missing);
    expect(priceAnthropicReceipt(writeAboveInput)).toBe(writeAboveInput);
    expect(priceAnthropicReceipt(priority)).toBe(priority);
  });
});
