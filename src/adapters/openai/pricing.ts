import { ProviderError } from "../../errors";

const PRICING_USD_PER_MILLION_TOKENS: Record<string, { prompt: number; completion: number }> = {
  "gpt-4o-mini": { prompt: 0.15, completion: 0.6 },
};

export function calculateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = PRICING_USD_PER_MILLION_TOKENS[model];
  if (!pricing) {
    throw new ProviderError(`No pricing configured for OpenAI model "${model}"`, "openai");
  }
  return (promptTokens * pricing.prompt + completionTokens * pricing.completion) / 1_000_000;
}
