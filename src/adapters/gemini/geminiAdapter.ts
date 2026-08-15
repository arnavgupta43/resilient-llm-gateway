import { ProviderError } from "../../errors";
import type { GatewayCompletionRequest, GatewayCompletionResult, GatewayMessage, ProviderAdapter } from "../types";
import { calculateCostUsd } from "./pricing";

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";

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
