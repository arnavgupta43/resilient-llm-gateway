import Anthropic from "@anthropic-ai/sdk";
import { loadEnv } from "../../config/env";
import type { AnthropicMessagesClient } from "./anthropicAdapter";

export function toMessagesClient(sdk: Anthropic): AnthropicMessagesClient {
  return {
    messages: {
      async create(params) {
        const response = await sdk.messages.create({
          model: params.model,
          max_tokens: params.max_tokens,
          system: params.system,
          messages: params.messages,
        });

        return {
          content: response.content.map((block) => ({
            type: block.type,
            text: "text" in block ? block.text : undefined,
          })),
          usage: {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
          },
        };
      },
    },
  };
}

let sharedClient: AnthropicMessagesClient | undefined;

export function getAnthropicClient(): AnthropicMessagesClient {
  if (!sharedClient) {
    const env = loadEnv();
    sharedClient = toMessagesClient(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }));
  }
  return sharedClient;
}
