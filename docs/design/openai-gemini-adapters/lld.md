# LLD: OpenAI + Gemini Provider Adapters

**Status:** Draft
**Depends on:** [`hld.md`](./hld.md)

## 1. Module layout

```
src/
  adapters/
    openai/
      openaiAdapter.ts    # OpenAIAdapter + OpenAIChatClient port interface
      client.ts            # wraps the real `openai` SDK into that port
      pricing.ts            # calculateCostUsd() for OpenAI models
    gemini/
      geminiAdapter.ts     # GeminiAdapter + GeminiGenerateContentClient port interface
      client.ts             # wraps the real `@google/genai` SDK into that port
      pricing.ts              # calculateCostUsd() for Gemini models
  config/
    env.ts                  # MODIFIED — + OPENAI_API_KEY, GEMINI_API_KEY
tests/unit/adapters/
  openaiAdapter.test.ts    # NEW
  geminiAdapter.test.ts    # NEW
package.json                 # MODIFIED — + openai, @google/genai deps
.env.example                 # MODIFIED
```

Exact mirror of `src/adapters/anthropic/`, one directory per provider, same three files. No shared base class between adapters — `ProviderAdapter` (an interface, not a class) is the only thing they have in common, which is deliberate: each provider's request/response shape is different enough (see §3, §4) that a shared abstract base would just be a home for `if (provider === ...)` branches. Three independent implementations of one interface is simpler than one implementation with branches.

## 2. The "port" pattern, explained

Both new adapters follow the same trick `AnthropicAdapter` already uses, worth naming explicitly since it repeats twice more here:

Instead of typing the adapter's constructor as `OpenAI` (the real SDK class) or `GoogleGenAI` (the real SDK class), each adapter depends on a **narrow interface** describing only the one method it actually calls. `client.ts` is the only file that imports the real SDK and adapts it to that interface. This is the **Adapter pattern applied twice**: once at the architecture level (`ProviderAdapter` — normalizing three providers to one gateway shape, per `architecture.md` §6.6) and once again at the test level (the "port" interface — normalizing "the one SDK method we call" so tests can swap in a fake with zero mocking library involved).

Why bother: `jest.mock('openai')` would require replicating the SDK's internal module shape and breaks quietly if the SDK's internals change on a version bump. A hand-written fake object satisfying a 5-line interface can't drift like that — if the port interface stops matching what `client.ts` needs, TypeScript fails to compile, not a test failure discovered later.

## 3. OpenAI Adapter

### 3.1 Port interface + adapter

```ts
// openaiAdapter.ts
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

function toOpenAIMessages(messages: GatewayMessage[]) {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

No `toOpenAIMessages` translation logic beyond a straight map — worth noting *why* this is simpler than the Anthropic version: Anthropic's Messages API rejects `system` as a message role (it's a separate top-level param), so `AnthropicAdapter` has to filter and join system messages out. OpenAI's Chat Completions API accepts `"system"` as a normal entry in the `messages` array, so there's nothing to extract.

`response.choices[0]?.message.content ?? ""` — the `?.` (optional chaining) guards an empty `choices` array (shouldn't happen on a successful call, but the SDK's type says it's possible), and `content` itself is typed nullable by the SDK (`string | null`), hence `?? ""`.

### 3.2 `client.ts`

```ts
// client.ts
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
            max_tokens: params.max_tokens,
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
```

Exact structural mirror of `anthropic/client.ts`: a pure mapping function (`toChatClient`, unit-testable but in practice exercised indirectly via the adapter tests against a hand-rolled fake — same as Anthropic's `toMessagesClient`) plus a lazily-initialized module-level singleton so the SDK client (and its underlying HTTP connection pool) is constructed once per process, not once per request.

### 3.3 `pricing.ts`

```ts
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
```

Byte-for-byte the same shape as `anthropic/pricing.ts`, just a different table and provider name in the error message.

## 4. Gemini Adapter

### 4.1 Port interface + adapter

```ts
// geminiAdapter.ts
import { ProviderError } from "../../errors";
import type { GatewayCompletionRequest, GatewayCompletionResult, GatewayMessage, ProviderAdapter } from "../types";
import { calculateCostUsd } from "./pricing";

export const DEFAULT_GEMINI_MODEL = "gemini-1.5-flash";

export interface GeminiGenerateContentClient {
  generateContent(params: {
    model: string;
    systemInstruction: string | undefined;
    contents: { role: "user" | "model"; parts: { text: string }[] }[];
  }): Promise<{
    text: string;
    usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
  }>;
}

export class GeminiAdapter implements ProviderAdapter {
  readonly name = "gemini";

  constructor(
    private readonly client: GeminiGenerateContentClient,
    private readonly model: string = DEFAULT_GEMINI_MODEL,
  ) {}

  async complete(request: GatewayCompletionRequest): Promise<GatewayCompletionResult> {
    const { systemInstruction, contents } = toGeminiContents(request.messages);
    const startedAt = Date.now();

    let response;
    try {
      response = await this.client.generateContent({ model: this.model, systemInstruction, contents });
    } catch (err) {
      throw new ProviderError(`Gemini request failed: ${toErrorMessage(err)}`, this.name, { cause: err });
    }

    const latencyMs = Date.now() - startedAt;

    return {
      content: response.text,
      provider: this.name,
      model: this.model,
      promptTokens: response.usageMetadata.promptTokenCount,
      completionTokens: response.usageMetadata.candidatesTokenCount,
      costUsd: calculateCostUsd(
        this.model,
        response.usageMetadata.promptTokenCount,
        response.usageMetadata.candidatesTokenCount,
      ),
      latencyMs,
    };
  }
}

function toGeminiContents(messages: GatewayMessage[]): {
  systemInstruction: string | undefined;
  contents: { role: "user" | "model"; parts: { text: string }[] }[];
} {
  const systemInstruction = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  const contents = messages
    .filter((message): message is GatewayMessage & { role: "user" | "assistant" } => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? ("model" as const) : ("user" as const),
      parts: [{ text: message.content }],
    }));

  return { systemInstruction: systemInstruction.length > 0 ? systemInstruction : undefined, contents };
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

`toGeminiContents` is structurally `AnthropicAdapter`'s `toAnthropicMessages` with one extra step: same system-message filter-and-join, same `role !== "system"` type-narrowing filter (the `message is GatewayMessage & { role: "user" | "assistant" }` return type is a **type predicate** — it tells TypeScript that after this filter, the array element type has narrowed from `GatewayMessage` to just the `user`/`assistant` variant, which is what lets the next `.map()` treat `message.role` as never being `"system"`), plus the `assistant → model` rename Anthropic doesn't need.

### 4.2 `client.ts`

```ts
// client.ts
import { GoogleGenAI } from "@google/genai";
import { loadEnv } from "../../config/env";
import type { GeminiGenerateContentClient } from "./geminiAdapter";

export function toGenerateContentClient(sdk: GoogleGenAI): GeminiGenerateContentClient {
  return {
    async generateContent(params) {
      const response = await sdk.models.generateContent({
        model: params.model,
        contents: params.contents,
        config: params.systemInstruction ? { systemInstruction: params.systemInstruction } : undefined,
      });
      return {
        text: response.text ?? "",
        usageMetadata: {
          promptTokenCount: response.usageMetadata?.promptTokenCount ?? 0,
          candidatesTokenCount: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    },
  };
}

let sharedClient: GeminiGenerateContentClient | undefined;

export function getGeminiClient(): GeminiGenerateContentClient {
  if (!sharedClient) {
    const env = loadEnv();
    sharedClient = toGenerateContentClient(new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }));
  }
  return sharedClient;
}
```

### 4.3 `pricing.ts`

```ts
import { ProviderError } from "../../errors";

const PRICING_USD_PER_MILLION_TOKENS: Record<string, { prompt: number; completion: number }> = {
  "gemini-1.5-flash": { prompt: 0.075, completion: 0.3 },
};

export function calculateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = PRICING_USD_PER_MILLION_TOKENS[model];
  if (!pricing) {
    throw new ProviderError(`No pricing configured for Gemini model "${model}"`, "gemini");
  }
  return (promptTokens * pricing.prompt + completionTokens * pricing.completion) / 1_000_000;
}
```

## 5. `env.ts` changes

```ts
const envSchema = z.object({
  // ...existing fields...
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),   // NEW
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),   // NEW
  // ...
});
```

Both required, not optional — `loadEnv()` throws at boot if either is missing, same fail-fast treatment as the existing Anthropic key. `.env.example` gets both new lines added under the existing `ANTHROPIC_API_KEY=` line.

## 6. `package.json` changes

```json
"dependencies": {
  "@google/genai": "^2.17.1",
  "openai": "^7.4.0"
}
```

(Alphabetical, matching the existing dependency list's ordering.) Both are current major versions as of drafting this LLD — confirm nothing newer/breaking has shipped before running `npm install`.

## 7. Tests

One file per adapter, structurally identical to `tests/unit/adapters/anthropicAdapter.test.ts` — same `makeClient(...)` helper pattern, same five cases adapted to each provider's shapes:

```ts
// tests/unit/adapters/openaiAdapter.test.ts
function makeClient(create: OpenAIChatClient["chat"]["completions"]["create"]): OpenAIChatClient {
  return { chat: { completions: { create } } };
}
```

```ts
// tests/unit/adapters/geminiAdapter.test.ts
function makeClient(generateContent: GeminiGenerateContentClient["generateContent"]): GeminiGenerateContentClient {
  return { generateContent };
}
```

Cases per adapter (mirrors Anthropic's five):

1. System message extraction + role mapping — for OpenAI, assert `system` role passes straight through unmodified; for Gemini, assert `systemInstruction` is set and `contents` only has the non-system messages with `assistant` renamed to `model`.
2. Successful response → `GatewayCompletionResult` with correctly computed `costUsd` (use round numbers, e.g. 1,000,000 prompt/completion tokens each, same trick as the Anthropic test, so the expected cost is just the per-million rate).
3. Empty/missing content handled without throwing (`choices[0]?.message.content` for OpenAI, `response.text` for Gemini) — the equivalent of Anthropic's "multiple text blocks" case doesn't apply here since neither SDK's response shape has that structure, so this case is about a *missing* content field instead, not multiple content parts.
4. Client failure wrapped in `ProviderError` with `cause` preserved and `provider` set (`"openai"` / `"gemini"`).
5. Unconfigured model → `ProviderError` from `calculateCostUsd` (pass an unknown model string to the adapter's constructor, same as the Anthropic test's `"claude-unknown-model"` case).

No dedicated `pricing.test.ts` for either — same as Anthropic, cost math is exercised through the adapter tests (cases 2 and 5 above), not a separate suite.

## 8. Out of scope (repeats HLD §8 for completeness)

`app.ts`/`server.ts` wiring, Circuit Breaker, Fallback Orchestrator, Complexity Router, streaming, tool calling.
