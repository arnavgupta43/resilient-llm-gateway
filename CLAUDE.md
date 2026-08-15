# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A self-hosted gateway between client apps and multiple LLM providers (Anthropic, OpenAI, Gemini): per-key rate limiting, complexity-based routing, cross-provider fallback with circuit breakers, per-request cost/token logging, and event-driven alerting via RabbitMQ → AWS EventBridge → Lambda → Slack/email.

Full system design lives in **`architecture.md`** — read it before making structural changes. `spec.md` (in Downloads, not this repo) was the original brief; `architecture.md` is the authoritative, current design and overrides `spec.md` wherever they disagree.

**Load-bearing decision: there is no caching layer.** Do not add a semantic cache, embedding-based lookup, or a "Volatile-Content Filter" — this was deliberately scoped out (see `architecture.md` §12 for why) after the original spec's own semantic-cache design was judged too unpredictable relative to its value. If a task seems to call for caching LLM responses, stop and check with the user before implementing it — don't silently reintroduce it because it appeared in an earlier draft of the spec.

## Tech stack

- Node.js + TypeScript
- Express 5.x (HTTP) — chosen over Fastify for familiarity; the gateway is I/O-bound on slow provider calls, so Fastify's routing-layer performance edge doesn't matter here. Must be Express 5, not 4 — 5.x auto-catches rejected promises in async route handlers, which 4.x doesn't.
- Redis (rate-limiter token buckets, circuit-breaker state) — plain Redis, not Redis Stack (no vector search needed)
- Postgres (request cost/token log, event audit log, `api_keys` tier mapping)
- RabbitMQ (internal event bus)
- AWS EventBridge + Lambda (alert sink only — the one component allowed to talk to AWS)

## Key config values (see `architecture.md` §11 for rationale)

- Rate limiter: flat 1 token per request. Tiers: free (C=20, R=0.33/s), pro (C=60, R=1/s), enterprise (C=120, R=2/s).
- Circuit breaker: N=5 failures, W=60s window, T=30s cooldown.

## Conventions

- Atomic Redis operations (rate-limiter check-refill-deduct, circuit-breaker increment-check-flip) must be single Lua `EVAL` scripts — never separate GET/SET round-trips, which race across gateway instances.
- The Complexity Router is a pure function: given a request, return an ordered provider list. It never calls a provider and never logs — keep it that way so it stays unit-testable without mocks.
- Gateway Core is the only component that writes to the `requests` Postgres table (it's the only place with final provider/tokens/latency after the call returns). Other components report state changes via the Event Publisher (`publish(eventType, payload, severity)`), not direct Postgres writes.
- Provider Adapters normalize to/from a single internal request/response shape — provider-specific logic (message format translation, auth, error mapping) stays inside the adapter, never leaks into Gateway Core, Router, or Orchestrator.
- Two distinct things are both called "tier" in this codebase — don't conflate them: **routing tier** (`complex`/`simple`, from the Complexity Router) and **rate-limit tier** (`free`/`pro`/`enterprise`, from the API key). Name types accordingly (e.g. `RoutingTier` vs `RateLimitTier`).

## Logging

Centralized, structured logging across the whole project — not `console.log` scattered per-file.

- Use **Node's `AsyncLocalStorage` (ALS)** to carry request-scoped context (correlation/request ID, `api_key_id`, `feature_id`) through the whole async call chain without threading it through every function signature. Establish the ALS context once, in the first Express middleware in the chain, at the top of the request lifecycle — before the Rate Limiter runs. Express has no built-in per-request child logger (unlike Fastify), so this middleware is where the ALS store *and* a bound Pino child logger both get created.
- **Correlation ID:** read `X-Request-ID` from the incoming request if present, else generate one (uuid). Echo it back on the response header. Every log line emitted anywhere during that request — Gateway Core, Rate Limiter, Router, Orchestrator, Adapters, Event Publisher — must carry it, pulled from ALS, not passed as a parameter.
- **Format:** structured (JSON), not string interpolation — every log line has a consistent shape: timestamp, level, component/service name, correlation ID, message, plus structured fields for anything else relevant (e.g. `provider`, `tier`, `latency_ms`). Use `pino` as the logger; since Express doesn't wire a per-request child logger automatically, pull the ALS-bound child logger via a shared helper (e.g. `getLogger()` reading from ALS) rather than passing a logger instance around.
- A log line missing its correlation ID/headers during a real request is a bug — it means something logged outside the ALS context (e.g. a fire-and-forget callback that escaped the async chain) and needs fixing, not suppressing.

## Error Handling

- No silent failures: no empty `catch` blocks, no swallowing an error and continuing as if nothing happened. If a failure is genuinely recoverable (e.g. Fallback Orchestrator trying the next provider), that's a deliberate, logged decision — not a swallowed exception.
- Use typed/custom error classes to distinguish operational errors (`RateLimitExceededError`, `ProviderError`, `CircuitOpenError`) from unexpected/programmer errors. Operational errors are expected, mapped to specific HTTP responses, and logged at `info`/`warn`; unexpected errors are logged at `error` with full stack and should trip alerting where relevant.
- Central Express error-handling middleware (the four-arg `(err, req, res, next)` signature, mounted last) maps known error types to HTTP responses — individual routes/components shouldn't hand-roll `res.status(...)` error mapping. Since this is Express 5, async route handlers can `throw`/reject directly and it'll reach this middleware without a manual try/catch wrapper.
- Every caught error gets logged with its ALS-derived context attached (see Logging above) before being handled/rethrown/mapped — never lose the correlation ID between where an error occurs and where it's logged.

## Comments

Default to no comments — well-named identifiers should carry the "what." The exception: a short (one-line) comment on any line or block that's genuinely hard to read at a glance even for someone familiar with the codebase — e.g. the body of a Lua `EVAL` script, a non-obvious regex, bit-twiddling, or an unusual control-flow choice made to avoid a specific race condition. Explain the *why*, not the *what*.

## Testing

Tests are the backbone of this project, not an afterthought bolted on at the end. Write tests test-first (red-green-refactor) for logic components — don't implement a component and then backfill tests for it.

- **Unit tests are the priority for logic.** Every pure/logic component gets thorough unit coverage: token-bucket math, circuit-breaker state transitions (closed→open→half-open→closed), Complexity Router heuristics, cost calculation, Lua script behavior. These are cheap, fast, and should cover edge cases (e.g. exact threshold boundaries, concurrent-failure counting) precisely because the components are pure/deterministic and have no excuse for untested branches.
- **E2E tests run against real local services, not mocks.** Since Redis, Postgres, and RabbitMQ all run locally (docker-compose) for this project, there's little reason to mock them in e2e tests the way you would for a hosted-dependency project — spin up the real local stack and test the gateway against it. This catches integration bugs unit tests can't (e.g. a Lua script that's correct in isolation but races against a real concurrent instance, or a circuit breaker that behaves differently once Redis round-trip latency is real).
- Provider adapters are the one place mocking is expected in tests — don't make real Anthropic/OpenAI/Gemini API calls in the test suite. Mock at the adapter boundary; everything upstream of the adapter (Router, Orchestrator, Rate Limiter) gets exercised for real.
- Test runner/framework choice is deferred to project scaffolding (Build order step 1) rather than decided here — pick something with strong native TypeScript + ESM support.

## Git Hooks / Pre-push CI Gate

A `pre-push` git hook (Husky) runs the CI/CD gate locally before any push reaches the remote — catch failures before they become someone else's problem, not after.

- **Runs, in order (fail fast — cheapest checks first):** typecheck (`tsc --noEmit`) → lint → unit tests → e2e tests (against the local docker-compose stack) → build.
- **Blocks the push** on: any TypeScript type error, any lint *error* (lint *warnings* don't block — they're not the "critical fail" this gate exists for), any failing test (unit or e2e), or a failed build. Any one of these failing stops the push.
- E2E tests in the hook assume the local docker-compose stack (Redis/Postgres/RabbitMQ) is already up. If it's unreachable, e2e tests fail closed (block the push) rather than being silently skipped — a push shouldn't succeed just because the test environment happened to be down.
- Wire this as a single `npm run ci` script (chaining the steps above) that both the pre-push hook and any future actual CI/CD pipeline call — one source of truth for what "passing" means, not hook logic duplicated from a separate CI config.
- **Docs-only pushes skip the gate entirely.** The hook diffs the files changed between what's on the remote and what's being pushed; if every changed file ends in `.md`, it exits early without running `npm run ci`. Mirrors the docs-only exception in "Git Workflow" above — no reason to spin up Postgres and run the full suite for a README edit. A push touching even one non-`.md` file still runs the full gate. New-branch pushes (nothing to diff against on the remote yet) always run the full gate rather than trying to guess.

## Git Workflow

- Never commit or push directly to `main` for code changes. Every code change happens on its own feature branch (short, descriptive, kebab-case — e.g. `rate-limiter-token-bucket`).
- **Exception: docs-only changes** (`CLAUDE.md`, `architecture.md`, `spec.md`) that don't touch code can be committed and pushed directly to `main` — no branch/PR needed.
- **Keep commits small and reviewable.** One logical change per commit, not a whole build-order step bundled into a single commit — the user wants to read each diff and follow how the system is built, not review a wall of code after the fact. If a step naturally breaks into parts (e.g. "the Lua script" vs "the middleware that calls it"), commit them separately.
- **Every branch gets a PR before merging**, with a description covering:
  - **What** changed
  - **Why** (the motivation/context behind the change)
  - **How** (the approach taken, any notable tradeoffs)
- **Do not merge to `main` without the user's review and explicit go-ahead.** Push the branch, open the PR, post the link, and stop there — merging happens only after the user has reviewed it.
- This applies from build order step 2 onward. Step 1 was committed directly to `main` as the initial scaffold before this workflow was adopted — don't treat that as precedent.

## Build order

Follow `architecture.md` §10 — build incrementally, single-provider-passthrough first, alerting last. Don't jump ahead to circuit breakers/fallback before a single adapter + Postgres logging works end-to-end. Testing infrastructure (test runner, docker-compose e2e stack, the `pre-push` hook) gets set up as part of step 1, alongside the first adapter — not deferred to the end, since TDD means every component from step 1 onward is written test-first.

## Status

Build order step 1 complete: Gateway Core (Express, ALS logging, error handling) + Anthropic Adapter + Postgres request logging, single-provider passthrough, with unit + e2e tests and the pre-push CI gate all in place. Committed directly to `main` as the initial scaffold. Next up is step 2 (Redis-backed rate limiter) — per Git Workflow above, that and everything after goes through a feature branch + PR.
