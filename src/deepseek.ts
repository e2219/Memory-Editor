import type {
  AnalyzerOutput,
  AnalyzerRequest,
  NarratorOutput,
  NarratorRequest,
} from "./contracts.ts";
import {
  ANALYZER_SYSTEM_PROMPT,
  NARRATOR_SYSTEM_PROMPT,
} from "./prompts.ts";
import type { RawModelGateway } from "./model.ts";

export interface DeepSeekOptions {
  apiKey: string;
  model?: string;
  apiUrl?: string;
  timeoutMs?: number;
  beforeRequest?: () => Promise<void>;
}

interface DeepSeekResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export class DeepSeekGateway implements RawModelGateway {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #apiUrl: string;
  readonly #timeoutMs: number;
  readonly #beforeRequest?: () => Promise<void>;

  constructor(options: DeepSeekOptions) {
    this.#apiKey = options.apiKey.trim();
    this.#model = options.model ?? "deepseek-chat";
    this.#apiUrl = options.apiUrl ?? "https://api.deepseek.com/chat/completions";
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#beforeRequest = options.beforeRequest;
  }

  analyze(request: AnalyzerRequest): Promise<unknown> {
    return this.#requestJson(ANALYZER_SYSTEM_PROMPT, request, 0.1, 900);
  }

  narrate(request: NarratorRequest): Promise<unknown> {
    return this.#requestJson(NARRATOR_SYSTEM_PROMPT, request, 0.7, 700);
  }

  async probe(): Promise<void> {
    const result = await this.#requestJson(
      "你是 API 连通性测试器。只输出 JSON，不输出其他文字。",
      { request: "请返回 {\"ok\":true}" },
      0,
      50,
    );
    if (
      typeof result !== "object" ||
      result === null ||
      (result as { ok?: unknown }).ok !== true
    ) {
      throw new Error("deepseek_probe_invalid_json");
    }
  }

  async #requestJson(
    systemPrompt: string,
    payload: unknown,
    temperature: number,
    maxTokens: number,
  ): Promise<AnalyzerOutput | NarratorOutput | Record<string, unknown>> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.#beforeRequest?.();
      try {
        const response = await fetch(this.#apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.#apiKey}`,
          },
          body: JSON.stringify({
            model: this.#model,
            messages: [
              { role: "system", content: systemPrompt },
              {
                role: "user",
                content: `请根据以下 JSON 输入返回 JSON：\n${JSON.stringify(payload)}`,
              },
            ],
            response_format: { type: "json_object" },
            temperature,
            max_tokens: maxTokens,
            stream: false,
          }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });

        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`deepseek_http_${response.status}`);
        }

        const data = await response.json() as DeepSeekResponse;
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error("deepseek_empty_content");
        const normalized = content.trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/, "");
        return JSON.parse(normalized) as
          | AnalyzerOutput
          | NarratorOutput
          | Record<string, unknown>;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("deepseek_request_failed");
  }
}
