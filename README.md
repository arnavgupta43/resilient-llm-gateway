# Resilient LLM Gateway

A self-hosted gateway that sits between client applications and multiple LLM providers (Anthropic, OpenAI, Gemini). It solves three problems apps hit when calling providers directly:

1. **Fragility** — one provider going down or rate-limiting takes the whole app down.
2. **Cost blindness** — no visibility into what's being spent per feature.
3. **Cost inefficiency** — sending every request to an expensive model even when a cheap one would do.

It does this with per-key rate limiting, complexity-based routing, cross-provider fallback with circuit breakers, per-request cost/token logging, and an event-driven alerting path that ends in an AWS Lambda notification sink. There is no caching layer — see [`architecture.md`](./architecture.md) §12 for why.

## Status

**Build order step 1 complete:** Gateway Core + Anthropic Adapter + Postgres request logging, single-provider passthrough, end to end. Everything else below is roadmap, not yet built.

| Step | What | Status |
|---|---|---|
| 1 | Gateway Core + one Provider Adapter + Postgres request logging | ✅ Done |
| 2 | Rate Limiter (Redis, Lua token bucket, tiered) | ⬜ Not started |
| 3 | Remaining adapters + Circuit Breaker + Fallback Orchestrator | ⬜ Not started |
| 4 | Complexity Router + tier-aware fallback + `tier_downgrade` | ⬜ Not started |
| 5 | Event Publisher + RabbitMQ + Logger Consumer | ⬜ Not started |
| 6 | Alert Relay + EventBridge + Lambda | ⬜ Not started |

## Architecture

```mermaid
flowchart TD
    Client[Client Apps - full history each call] --> GW[Gateway Core]

    GW --> RL[Redis: Token Bucket Rate Limiter]
    GW --> Router[Complexity Router]

    CB[(Redis: Circuit Breaker State)] --> FB[Fallback Orchestrator]
    Router --> FB

    FB --> A1[Anthropic Adapter]
    FB --> A2[OpenAI Adapter]
    FB --> A3[Gemini Adapter]

    GW --> PG[(Postgres: request + cost log)]
    GW --> EP[Event Publisher util]

    EP --> MQ[RabbitMQ: event bus]
    MQ --> LOG[Logger Consumer] --> PG
    MQ --> AR[Alert Relay Consumer]
    AR -->|severity=alert only| EB[AWS EventBridge]
    EB --> L[AWS Lambda]
    L --> SL[Slack / Email]
```

Full design lives in [`architecture.md`](./architecture.md). The original brief is [`spec.md`](./spec.md); `architecture.md` overrides it wherever they disagree. Repo/engineering conventions (logging, error handling, testing, git workflow) live in [`CLAUDE.md`](./CLAUDE.md).

## Tech stack

- Node.js + TypeScript
- Express 5.x
- Redis (rate-limiter buckets, circuit-breaker state) — not yet wired up
- Postgres (request cost/token log, event audit log)
- RabbitMQ (internal event bus) — not yet wired up
- AWS EventBridge + Lambda (alert sink) — not yet wired up

## Getting started

**Prerequisites:** Node.js 22+, Docker Desktop, an Anthropic API key.

```bash
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY; DATABASE_URL default matches docker-compose

docker compose up -d   # starts local Postgres (dev + test)
npm run migrate         # applies schema to $DATABASE_URL

npm run dev             # starts the gateway on $PORT (default 3000)
```

### Try it

```bash
curl http://localhost:3000/v1/completions \
  -H "Content-Type: application/json" \
  -H "x-api-key: local-dev-key" \
  -d '{
    "feature_id": "capital-qa",
    "messages": [{ "role": "user", "content": "What is the capital of France?" }]
  }'
```

## Testing

Tests are the backbone of this project — see `CLAUDE.md` "Testing" for the full philosophy (TDD, unit-first for logic, e2e against real local services).

```bash
npm test          # unit tests
npm run test:e2e   # e2e tests, requires `docker compose up -d` running
npm run test:all   # both
npm run ci          # the full pre-push gate: typecheck -> lint -> unit -> e2e -> build
```

A Husky `pre-push` hook runs `npm run ci` automatically and blocks the push on any failure.

## Project docs

- [`spec.md`](./spec.md) — original technical spec, with revision history
- [`architecture.md`](./architecture.md) — current authoritative system design
- [`CLAUDE.md`](./CLAUDE.md) — conventions: logging, error handling, testing, git workflow
