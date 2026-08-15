import { ProviderError } from "../../errors";

const PRICING_USD_PER_MILLION_TOKENS: Record<string, { prompt: number; completion: number }> = {
  "gemini-2.5-flash-lite": { prompt: 0.1, completion: 0.4 },
};

export function calculateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = PRICING_USD_PER_MILLION_TOKENS[model];
  if (!pricing) {
    throw new ProviderError(`No pricing configured for Gemini model "${model}"`, "gemini");
  }
  return (promptTokens * pricing.prompt + completionTokens * pricing.completion) / 1_000_000;
}
