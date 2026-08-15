import OpenAI from "openai";
import { loadEnv } from "../../config/env";
import type { OpenAIChatClient } from "./openaiAdapter";

export function toChatClient(sdk: OpenAI): OpenAIChatClient {
  return {
    chat: {
      completions: {
        async create(params) {
          const response = await sdk.chat.completions.create({
            model: params.model,
            // max_tokens is deprecated in the OpenAI SDK in favor of
            // max_completion_tokens; the port interface keeps `max_tokens`
            // as the gateway-internal name (matching the Anthropic adapter),
            // this is the one place it gets translated to the current param.
            max_completion_tokens: params.max_tokens,
            messages: params.messages,
          });
          return {
            choices: response.choices.map((choice) => ({ message: { content: choice.message.content } })),
            usage: {
              prompt_tokens: response.usage?.prompt_tokens ?? 0,
              completion_tokens: response.usage?.completion_tokens ?? 0,
            },
          };
        },
      },
    },
  };
}

let sharedClient: OpenAIChatClient | undefined;

export function getOpenAIClient(): OpenAIChatClient {
  if (!sharedClient) {
    const env = loadEnv();
    sharedClient = toChatClient(new OpenAI({ apiKey: env.OPENAI_API_KEY }));
  }
  return sharedClient;
}
