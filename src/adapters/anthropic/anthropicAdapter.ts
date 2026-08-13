import { ProviderError } from "../../errors";
import type { GatewayCompletionRequest, GatewayCompletionResult, GatewayMessage, ProviderAdapter } from "../types";
import { calculateCostUsd } from "./pricing";

export const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-sonnet-20241022";
const MAX_TOKENS = 4096;

// The narrow slice of the Anthropic SDK's Messages API this adapter needs.
// Adapters depend on this port, not the SDK class directly, so unit tests
// can inject a fake without mocking the SDK module (see client.ts for the
// explicit mapping from the real SDK response into this shape).
export interface AnthropicMessagesClient {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      system: string | undefined;
      messages: { role: "user" | "assistant"; content: string }[];
    }): Promise<{
      content: { type: string; text?: string }[];
      usage: { input_tokens: number; output_tokens: number };
    }>;
  };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = "anthropic";

  constructor(
    private readonly client: AnthropicMessagesClient,
    private readonly model: string = DEFAULT_ANTHROPIC_MODEL,
  ) {}

  async complete(request: GatewayCompletionRequest): Promise<GatewayCompletionResult> {
    const { system, messages } = toAnthropicMessages(request.messages);
    const startedAt = Date.now();

    let response;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system,
        messages,
      });
    } catch (err) {
      throw new ProviderError(`Anthropic request failed: ${toErrorMessage(err)}`, this.name, { cause: err });
    }

    const latencyMs = Date.now() - startedAt;
    const content = response.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");

    return {
      content,
      provider: this.name,
      model: this.model,
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
      costUsd: calculateCostUsd(this.model, response.usage.input_tokens, response.usage.output_tokens),
      latencyMs,
    };
  }
}

function toAnthropicMessages(messages: GatewayMessage[]): {
  system: string | undefined;
  messages: { role: "user" | "assistant"; content: string }[];
} {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  const conversational = messages
    .filter((message): message is GatewayMessage & { role: "user" | "assistant" } => message.role !== "system")
    .map((message) => ({ role: message.role, content: message.content }));

  return { system: system.length > 0 ? system : undefined, messages: conversational };
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
