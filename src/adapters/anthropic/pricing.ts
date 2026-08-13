import { ProviderError } from "../../errors";

const PRICING_USD_PER_MILLION_TOKENS: Record<string, { prompt: number; completion: number }> = {
  "claude-3-5-sonnet-20241022": { prompt: 3, completion: 15 },
  "claude-3-5-haiku-20241022": { prompt: 1, completion: 5 },
};

export function calculateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = PRICING_USD_PER_MILLION_TOKENS[model];
  if (!pricing) {
    throw new ProviderError(`No pricing configured for Anthropic model "${model}"`, "anthropic");
  }
  return (promptTokens * pricing.prompt + completionTokens * pricing.completion) / 1_000_000;
}
