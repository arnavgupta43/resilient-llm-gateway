import { Router } from "express";
import { z } from "zod";
import { ValidationError } from "../errors";
import { getRequestContext } from "../logger/context";
import { getLogger } from "../logger";
import type { FallbackOrchestrator } from "../orchestrator/fallbackOrchestrator";
import type { RoutingTier } from "../orchestrator/types";
import type { RequestsRepo } from "../db/requestsRepo";

const completionRequestSchema = z.object({
  feature_id: z.string().min(1),
  task_type: z.string().optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string().min(1),
      }),
    )
    .min(1),
});

// Hardcoded until the Complexity Router lands (build order step 4) — every
// request starts in the complex tier. The FallbackOrchestrator can still
// downgrade a given request to "simple" if every complex-tier provider is
// unavailable (see requestsRepo.logRequest below, which logs the tier that
// actually served the request, not this starting hint).
const STARTING_TIER: RoutingTier = "complex";

export function createCompletionsRouter(orchestrator: FallbackOrchestrator, requestsRepo: RequestsRepo): Router {
  const router = Router();

  router.post("/v1/completions", async (req, res, next) => {
    try {
      // apiKeyId is guaranteed set here — authMiddleware runs before this
      // route and rejects the request (401) before context reaches it.
      const context = getRequestContext();
      const body = completionRequestSchema.parse(req.body);
      if (context) {
        context.featureId = body.feature_id;
      }

      const { result, tier } = await orchestrator.complete(
        { messages: body.messages, taskType: body.task_type },
        STARTING_TIER,
      );

      await requestsRepo.logRequest({
        apiKeyId: context?.apiKeyId as string,
        featureId: body.feature_id,
        provider: result.provider,
        tier,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
      });

      getLogger().info({ provider: result.provider, tier, latencyMs: result.latencyMs }, "completion served");

      res.status(200).json({
        content: result.content,
        provider: result.provider,
        model: result.model,
        prompt_tokens: result.promptTokens,
        completion_tokens: result.completionTokens,
        cost_usd: result.costUsd,
        latency_ms: result.latencyMs,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        next(new ValidationError(err.issues.map((issue) => issue.message).join("; ")));
        return;
      }
      next(err);
    }
  });

  return router;
}
