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
