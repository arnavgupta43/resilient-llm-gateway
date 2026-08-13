export interface GatewayMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface GatewayCompletionRequest {
  messages: GatewayMessage[];
  taskType?: string;
}

export interface GatewayCompletionResult {
  content: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface ProviderAdapter {
  readonly name: string;
  complete(request: GatewayCompletionRequest): Promise<GatewayCompletionResult>;
}
