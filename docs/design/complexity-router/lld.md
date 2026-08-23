# LLD: Complexity Router

**Status:** Finalized
**Depends on:** [`hld.md`](./hld.md)

## 1. Module layout

```
src/
  router/
    complexityRouter.ts   # NEW - chooseTier(), the lookup table, the heuristics
  routes/
    completions.ts        # MODIFIED - calls chooseTier() instead of a hardcoded STARTING_TIER
```

That's the whole change. No new folder for types/config the way `circuitBreaker/` and `rateLimiter/` each got one — there's nothing here that needs its own `types.ts` (the router produces a `RoutingTier`, a type that already exists) or a runtime `config.ts` (the thresholds are small enough to live as constants next to the code that uses them, unlike `CIRCUIT_BREAKER_CONFIG`, which gets constructed and passed around as an object at wiring time).

**No changes to `app.ts` or `server.ts`.** This is worth pausing on since every prior PR in this project touched both: `chooseTier` is a *pure function* — no Redis client, no Postgres pool, no HTTP client, nothing to construct or inject. The rate limiter and circuit breaker need dependency injection (`createTokenBucket(redis)`, `createCircuitBreaker(redis, config)`) because they hold a connection to something external; `chooseTier` holds nothing, so `completions.ts` just imports and calls it directly, the same way it already imports `z` or `ValidationError`. If this ever needs to look something up at runtime (a feature flag, per-`feature_id` overrides — both explicitly out of scope per `hld.md` §6) it would need to become an injected dependency at that point, but not before.

## 2. `router/complexityRouter.ts`

```ts
import type { GatewayCompletionRequest } from "../adapters/types";
import type { RoutingTier } from "../orchestrator/types";

// hld.md §3.1. Exact-match against the caller's own task_type string.
const TASK_TYPE_TIER: Record<string, RoutingTier> = {
  summarization: "simple",
  classification: "simple",
  extraction: "simple",
  translation: "simple",
  code_generation: "complex",
  debugging: "complex",
  reasoning: "complex",
  analysis: "complex",
};

const LONG_PROMPT_THRESHOLD_CHARS = 600; // hld.md §3.2

const CODE_BLOCK_PATTERN = /```/;

const REASONING_KEYWORDS = ["explain step by step", "step by step", "prove", "debug", "walk me through", "why does"];

function latestUserMessageContent(request: GatewayCompletionRequest): string | undefined {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    if (request.messages[i].role === "user") return request.messages[i].content;
  }
  return undefined;
}

function matchesHeuristic(content: string): boolean {
  if (content.length > LONG_PROMPT_THRESHOLD_CHARS) return true;
  if (CODE_BLOCK_PATTERN.test(content)) return true;
  const lower = content.toLowerCase();
  return REASONING_KEYWORDS.some((keyword) => lower.includes(keyword));
}

export function chooseTier(request: GatewayCompletionRequest): RoutingTier {
  if (request.taskType !== undefined && request.taskType in TASK_TYPE_TIER) {
    return TASK_TYPE_TIER[request.taskType];
  }

  const content = latestUserMessageContent(request);
  if (content !== undefined && matchesHeuristic(content)) return "complex";

  return "simple";
}
```

A few things worth walking through:

- **`request.taskType in TASK_TYPE_TIER`** — the `in` operator checks *key presence* on the object, not whether the value is truthy. That distinction matters here because every value in `TASK_TYPE_TIER` happens to be a non-empty string (always truthy), so `TASK_TYPE_TIER[request.taskType] !== undefined` would behave identically today — but `in` is the version that stays correct if a future tier value could ever be falsy, and it reads as "is this a known key" rather than "did the lookup not fail," which is closer to what the code actually means. Small thing, but it's the kind of habit worth having by default rather than only reaching for when a bug forces it.
- **Backward loop in `latestUserMessageContent`** — `architecture.md` §2 says the client sends the *full* history each call, so `messages` can end in an assistant/system turn in principle (unusual, but the schema doesn't forbid it). Walking from the end and returning on the first `role: "user"` hit is simpler and cheaper than `messages.filter(m => m.role === "user").at(-1)`, which would build a whole intermediate array just to throw most of it away.
- **`matchesHeuristic` returns as soon as one signal fires** — this is the OR from `hld.md` §2.1 written directly as three early returns rather than `length > N || CODE_BLOCK_PATTERN.test(c) || REASONING_KEYWORDS.some(...)` as one boolean expression. Same result; this reads slightly easier top-to-bottom and makes it trivial to add a `getLogger().debug(...)` on a specific branch later if the thresholds ever need tuning against real traffic.
- **No exported constants** — `TASK_TYPE_TIER`, `LONG_PROMPT_THRESHOLD_CHARS`, etc. stay module-private. Nothing outside this file needs them; `chooseTier` is the entire public surface, consistent with CLAUDE.md's "pure function, unit-testable without mocks" framing — the tests exercise it through its one exported function, not by reaching into its internals.
- **`RoutingTier` imported from `orchestrator/types.ts`, not moved here.** Conceptually the *Router* owns this type — it's the thing the router's output is typed as. But `RoutingTier` already exists there, and `fallbackOrchestrator.ts`, `orchestrator/config.ts`, `completions.ts`, and their tests all already import it from that path. Moving it into `router/types.ts` for ownership-purity would touch four already-merged, already-tested files for no behavioral change — not worth the churn for this PR. `router/` importing *from* `orchestrator/` is a one-way dependency (orchestrator's files don't import anything from `router/`), so there's no cycle risk, just a slightly backwards-looking name. Worth revisiting only if `RoutingTier` needs to grow a third value or otherwise become router-specific enough to justify the move.

## 3. `routes/completions.ts` changes

Remove the hardcoded constant and its now-stale comment; call `chooseTier` per-request instead:

```ts
import { chooseTier } from "../router/complexityRouter";
// (RoutingTier import removed - no longer referenced directly in this file)

router.post("/v1/completions", async (req, res, next) => {
  try {
    const context = getRequestContext();
    const body = completionRequestSchema.parse(req.body);
    if (context) context.featureId = body.feature_id;

    const request = { messages: body.messages, taskType: body.task_type };
    const startingTier = chooseTier(request);
    const { result, tier } = await orchestrator.complete(request, startingTier);

    // ...unchanged from here: logRequest, response mapping, error handling
  }
  ...
});
```

`request` is pulled into its own variable instead of being built inline twice (once for `chooseTier`, once for `orchestrator.complete`) — passing the same object reference to both instead of reconstructing the literal twice.

## 4. Existing test that needs updating

`tests/unit/routes/completions.test.ts`'s first test currently asserts:

```ts
expect(complete).toHaveBeenCalledWith(
  { messages: [{ role: "user", content: "What is the capital of France?" }], taskType: undefined },
  "complex",
);
```

That `"complex"` was only ever correct because `STARTING_TIER` was hardcoded. "What is the capital of France?" is 32 characters, has no code block, and matches none of the reasoning keywords — under the new router it resolves to `"simple"`. This isn't a behavior regression, it's the fixture catching up to the fact that the starting tier is now actually being decided instead of assumed. Update the assertion to `"simple"`. The rest of that test (and the "logs the downgraded tier" test below it, which mocks the orchestrator's *returned* tier directly and never depended on the starting-tier constant) are unaffected.

## 5. New tests: `tests/unit/router/complexityRouter.test.ts`

Table-driven where possible — most of these cases are "given this input, expect this tier," which is a natural fit for `it.each` rather than a hand-written `it(...)` block per case.

```ts
import { chooseTier } from "../../../src/router/complexityRouter";
import type { GatewayCompletionRequest } from "../../../src/adapters/types";

function requestWith(content: string, taskType?: string): GatewayCompletionRequest {
  return { messages: [{ role: "user", content }], taskType };
}

describe("chooseTier", () => {
  describe("task_type lookup", () => {
    it.each([
      ["summarization", "simple"],
      ["classification", "simple"],
      ["code_generation", "complex"],
      ["debugging", "complex"],
    ] as const)("%s -> %s, regardless of message content", (taskType, expected) => {
      // message content deliberately contradicts the table entry, to prove
      // the lookup wins over the heuristics rather than just agreeing with them
      const content = expected === "simple" ? "```code```" : "hi";
      expect(chooseTier(requestWith(content, taskType))).toBe(expected);
    });

    it("unknown task_type falls through to heuristics", () => {
      expect(chooseTier(requestWith("hi", "some_made_up_type"))).toBe("simple");
      expect(chooseTier(requestWith("```code```", "some_made_up_type"))).toBe("complex");
    });
  });

  describe("length heuristic", () => {
    it("exactly at the boundary (600 chars) does not trigger complex", () => {
      expect(chooseTier(requestWith("a".repeat(600)))).toBe("simple");
    });

    it("one over the boundary (601 chars) triggers complex", () => {
      expect(chooseTier(requestWith("a".repeat(601)))).toBe("complex");
    });
  });

  describe("code block heuristic", () => {
    it("fenced code block triggers complex", () => {
      expect(chooseTier(requestWith("```\nconst x = 1;\n```"))).toBe("complex");
    });

    it("stray brace/semicolon without fencing does not trigger complex", () => {
      expect(chooseTier(requestWith("if (x) { y(); }"))).toBe("simple");
    });
  });

  describe("reasoning keyword heuristic", () => {
    it.each(["explain step by step", "prove", "debug", "walk me through", "why does"])(
      '"%s" triggers complex, case-insensitively',
      (keyword) => {
        expect(chooseTier(requestWith(`please ${keyword.toUpperCase()} this`))).toBe("complex");
      },
    );
  });

  it("multiple heuristics firing at once still resolves to complex (OR, not exclusive)", () => {
    expect(chooseTier(requestWith("```code```\n" + "please prove this".repeat(50)))).toBe("complex");
  });

  it("only scans the latest user message, not earlier history", () => {
    const request: GatewayCompletionRequest = {
      messages: [
        { role: "user", content: "```an earlier code block```" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "thanks" },
      ],
    };
    expect(chooseTier(request)).toBe("simple");
  });

  it("no user message at all falls through to simple rather than throwing", () => {
    const request: GatewayCompletionRequest = { messages: [{ role: "system", content: "you are a bot" }] };
    expect(chooseTier(request)).toBe("simple");
  });

  it("no task_type and no heuristic match defaults to simple", () => {
    expect(chooseTier(requestWith("hi"))).toBe("simple");
  });
});
```

## 6. Out of scope

Same as `hld.md` §6: no logging/event changes (the orchestrator's *served* tier is already what gets logged, unchanged by this PR), no threshold tuning against real traffic, no per-`feature_id` override.
