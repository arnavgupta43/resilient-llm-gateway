# HLD: OpenAI + Gemini Provider Adapters

**Status:** Finalized
**Build order:** step 3, adapters portion only (`architecture.md` §10) — Circuit Breaker + Fallback Orchestrator are a separate, later PR (they're a different concern: request routing/failover vs. per-provider translation)
**Related:** `architecture.md` §6.6 (Provider Adapters), §6.3 (Complexity Router tiers — informs default model choice below)

## 1. Goal

Add `OpenAIAdapter` and `GeminiAdapter`, both implementing the existing `ProviderAdapter` interface (`src/adapters/types.ts`), following the same shape as `AnthropicAdapter`. This PR makes both adapters fully implemented and unit-tested as standalone components — it does **not** wire them into the live request path.

## 2. Why adapters land before the Router/Orchestrator

`completions.ts` currently takes a single hardcoded `ProviderAdapter` (Anthropic) — there's no concept of "pick a provider" yet. Real multi-provider selection needs the Circuit Breaker (which providers are healthy) and Fallback Orchestrator (which one to try, in what order) from `architecture.md` §6.4–6.5, which don't exist yet and are scoped to the next PR.

So this PR produces two complete, independently testable adapters with no live callers — `app.ts`/`server.ts` stay untouched. They get wired in when the Orchestrator lands and `createCompletionsRouter` changes shape to accept a provider list instead of one adapter. This isn't a half-finished implementation in the sense CLAUDE.md warns against: each adapter is a complete, correct, tested unit on its own merits — it's the *caller* that doesn't exist yet, by explicit choice to split this into two reviewable PRs.

## 3. Per-adapter design

Same three-file pattern as `src/adapters/anthropic/` for both:

- `<provider>Adapter.ts` — the `ProviderAdapter` implementation. Depends on a narrow client **port interface** (e.g. `OpenAIChatClient`, `GeminiGenerateContentClient`), not the SDK class directly, so unit tests inject a fake without mocking SDK modules.
- `client.ts` — maps the real SDK into that port interface; owns SDK construction (API key from `loadEnv()`) and a lazily-created shared client singleton (mirrors `getAnthropicClient()`).
- `pricing.ts` — `calculateCostUsd(model, promptTokens, completionTokens)`, throws `ProviderError` for an unconfigured model (same as Anthropic's).

### 3.1 OpenAI Adapter

- **SDK:** `openai` (official Node SDK) — new dependency.
- **API surface:** Chat Completions (`client.chat.completions.create`) — stable, and structurally the closest match to Anthropic's Messages API and Gemini's `generateContent` (one synchronous call in, one response out, no server-side conversation state). The newer Responses API adds statefulness/built-in-tools surface this stateless gateway doesn't use.
- **Message mapping:** unlike Anthropic, OpenAI's Chat Completions accepts `system` as a normal message role inside the `messages` array — no separate `system` param to peel off. `GatewayMessage.role` values (`user`/`assistant`/`system`) map 1:1, no translation needed.
- **Default model:** `gpt-4o-mini`. Rationale: per `architecture.md` §6.3, OpenAI is the *fallback* in the `complex` tier (`[Anthropic, OpenAI]`) — it only gets called when Anthropic's circuit is open, so it doesn't need to match Anthropic's flagship quality, just be a reasonable, cheap stand-in.
- **Token usage:** response's `usage.prompt_tokens` / `usage.completion_tokens`.

### 3.2 Gemini Adapter

- **SDK:** `@google/genai` (Google's current unified GenAI SDK — the older `@google/generative-ai` is being phased out) — new dependency.
- **API surface:** `ai.models.generateContent({ model, contents, config: { systemInstruction } })`.
- **Message mapping, two translations needed (more than OpenAI, closer to Anthropic's shape):**
  - System messages pulled out into `config.systemInstruction`, same pattern as Anthropic's separate `system` param.
  - Role names differ: Gemini uses `"model"` where the gateway/OpenAI/Anthropic convention uses `"assistant"`. The adapter maps `assistant → model`, `user → user`.
- **Default model:** `gemini-2.5-flash-lite`. Rationale: per `architecture.md` §6.3, Gemini is the **only** provider in the `simple` tier — it's deliberately the cheap/fast option for requests the Complexity Router judged not to need a frontier model, so the default should stay on the cheap/fast end of Gemini's lineup, not its highest-capability one. (`gemini-1.5-flash`, the original choice, was confirmed retired — Google returns 404 on it as of August 2026; `gemini-2.5-flash-lite` is the current cheapest active Flash-tier model.)
- **Token usage:** response's `usageMetadata.promptTokenCount` / `usageMetadata.candidatesTokenCount`.
- **Note:** model IDs and pricing were verified against provider docs (OpenAI, `ai.google.dev/gemini-api/docs/pricing`) as of August 2026 while drafting this HLD — both providers iterate their lineups frequently, so re-check before reusing these figures much later.

## 4. Pricing tables

Same `Record<model, {prompt, completion}>` USD-per-million-tokens shape as `src/adapters/anthropic/pricing.ts`. Figures verified against current provider pricing pages (August 2026):

| Provider | Model | Prompt $/1M | Completion $/1M |
|---|---|---|---|
| OpenAI | `gpt-4o-mini` | 0.15 | 0.60 |
| Google | `gemini-2.5-flash-lite` | 0.10 | 0.40 |

## 5. Error handling

Same as Anthropic: any SDK call failure (network, 4xx/5xx from the provider) is caught and rethrown as `ProviderError(message, providerName, { cause: err })` — never swallowed, never left as a raw SDK error escaping the adapter boundary (per CLAUDE.md "Error Handling").

## 6. Config

New required env vars, added to `envSchema` (`src/config/env.ts`) and `.env.example`:

- `OPENAI_API_KEY`
- `GEMINI_API_KEY`

Both required (`.min(1, "... is required")`), matching `ANTHROPIC_API_KEY`'s treatment — consistent with "fail fast on missing config" rather than lazily erroring on first request.

## 7. Testing (per CLAUDE.md)

- **Unit only** — provider adapters are the one place mocking is expected; no real API calls in the suite.
- Mirrors `tests/unit/adapters/anthropicAdapter.test.ts` structure exactly, one test file per adapter:
  - Message/role translation (system extraction for both; `assistant → model` for Gemini; passthrough for OpenAI).
  - Successful response mapped into `GatewayCompletionResult` with correct cost calculation.
  - Multi-part / empty content handling if the SDK response shape allows it.
  - Client failure wrapped in `ProviderError` with `cause` preserved and `provider` set correctly.
  - Unconfigured model → `ProviderError` from `calculateCostUsd`.
- No e2e changes needed — adapters aren't reachable via HTTP yet (§2).

## 8. Out of scope

- Wiring adapters into `app.ts` / `completions.ts` routing (next PR, alongside Circuit Breaker + Fallback Orchestrator).
- Circuit Breaker, Fallback Orchestrator, Complexity Router.
- Streaming responses (no adapter, including Anthropic's, supports streaming today).
- Tool/function calling (not part of the gateway's current request/response shape).
