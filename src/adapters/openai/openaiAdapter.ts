import { ProviderError } from "../../errors";
import type { GatewayCompletionRequest, GatewayCompletionResult, GatewayMessage, ProviderAdapter } from "../types";
import { calculateCostUsd } from "./pricing";

export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const MAX_TOKENS = 4096;

export interface OpenAIChatClient {
  chat: {
    completions: {
      create(params: {
        model: string;
        max_tokens: number;
        messages: { role: "user" | "assistant" | "system"; content: string }[];
      }): Promise<{
        choices: { message: { content: string | null } }[];
        usage: { prompt_tokens: number; completion_tokens: number };
      }>;
    };
  };
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly name = "openai";

  constructor(
    private readonly client: OpenAIChatClient,
    private readonly model: string = DEFAULT_OPENAI_MODEL,
  ) {}

  async complete(request: GatewayCompletionRequest): Promise<GatewayCompletionResult> {
    const startedAt = Date.now();

    let response;
    try {
      response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        messages: toOpenAIMessages(request.messages),
      });
    } catch (err) {
      throw new ProviderError(`OpenAI request failed: ${toErrorMessage(err)}`, this.name, { cause: err });
    }

    const latencyMs = Date.now() - startedAt;
    const content = response.choices[0]?.message.content ?? "";

    return {
      content,
      provider: this.name,
      model: this.model,
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
      costUsd: calculateCostUsd(this.model, response.usage.prompt_tokens, response.usage.completion_tokens),
      latencyMs,
    };
  }
}

function toOpenAIMessages(
  messages: GatewayMessage[],
): { role: "user" | "assistant" | "system"; content: string }[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
