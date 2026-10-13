// OpenAI-compatible chat calls, always through receipts. One model is enough: `default` is whatever the
// deployment names in LLM_BASE_URL / LLM_API_KEY / LLM_MODEL, and every capability uses it unless an
// environment variable or the admin's model page picks one of the named presets below.
import type { z } from "zod";
import { config, credential } from "../config.ts";
import { sha256 } from "../lib/ids.ts";
import { completeReceipt, paidRequest, ProviderRejectedError, rejectReceivedResponse } from "./receipts.ts";
import { sql } from "../db.ts";
import { assertLingConfiguration, isLingModel, LING_MODEL, lingChatEndpoint, lingDefaultMatches, lingProfile, lingQuota } from "./model-profile.ts";
import { retryAfterSeconds } from "./provider-quotas.ts";

export interface ModelSpec {
  key: string;
  service: string;
  model: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
  /** Extra request fields, e.g. switching reasoning off for short structured tasks. */
  extra?: Record<string, unknown>;
  jsonMode: boolean;
  vision?: boolean;
}

function extraFromEnv(value: string | undefined, name = "LLM_EXTRA_JSON"): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error(`${name} must be a JSON object, e.g. {"enable_thinking": false}`);
  }
}

function reuseLingDefault(): boolean {
  return !credential("models", "ANT_LING_BASE_URL") && !credential("models", "ANT_LING_API_KEY") &&
    lingDefaultMatches(credential("models", "LLM_BASE_URL"), process.env.LLM_MODEL);
}

export const MODELS: Record<string, ModelSpec> = {
  // Read from the environment at call time.
  default: {
    key: "default", service: "llm", baseUrlEnv: "LLM_BASE_URL", apiKeyEnv: "LLM_API_KEY",
    get model() { return process.env.LLM_MODEL ?? ""; },
    get extra() { return extraFromEnv(process.env.LLM_EXTRA_JSON); },
    get jsonMode() { return process.env.LLM_JSON_MODE !== "false"; },
    get vision() { return process.env.LLM_VISION === "true"; },
  },
  "ling-3.1-flash": {
    key: "ling-3.1-flash", service: "llm", model: LING_MODEL,
    baseUrlEnv: "ANT_LING_BASE_URL", apiKeyEnv: "ANT_LING_API_KEY",
    get extra() {
      if (process.env.ANT_LING_EXTRA_JSON) return extraFromEnv(process.env.ANT_LING_EXTRA_JSON, "ANT_LING_EXTRA_JSON");
      return reuseLingDefault() ? extraFromEnv(process.env.LLM_EXTRA_JSON) : undefined;
    },
    get jsonMode() { return reuseLingDefault() ? process.env.LLM_JSON_MODE !== "false" : true; },
    vision: false,
  },
  // Named presets (the models AIHOT itself runs on); each needs its own key.
  // GLM 5.3 Flash always reasons; the lowest effort keeps short structured tasks fast.
  "glm-5.3-flash": {
    key: "glm-5.3-flash", service: "zhipu", model: "glm-5.3-flash",
    baseUrlEnv: "ZHIPU_BASE_URL", apiKeyEnv: "ZHIPU_API_KEY",
    extra: { thinking: { type: "enabled" }, reasoning_effort: "low" }, jsonMode: true,
  },
  // The scorer's parameters for glm-5.3-flash (score calls; temperature 1 is set per call).
  "glm-5.3-flash-selection": {
    key: "glm-5.3-flash-selection", service: "zhipu", model: "glm-5.3-flash",
    baseUrlEnv: "ZHIPU_BASE_URL", apiKeyEnv: "ZHIPU_API_KEY",
    extra: { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "high", top_p: 0.95 }, jsonMode: true,
  },
  // DeepSeek Flash reasons by default; structured tasks switch it off unless the -think variant is used.
  "deepseek-flash": {
    key: "deepseek-flash", service: "deepseek", model: "deepseek-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL", apiKeyEnv: "DEEPSEEK_API_KEY",
    extra: { thinking: { type: "disabled" } }, jsonMode: true,
  },
  "deepseek-flash-think": {
    key: "deepseek-flash-think", service: "deepseek", model: "deepseek-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL", apiKeyEnv: "DEEPSEEK_API_KEY", jsonMode: true,
  },
  "qwen3.7-flash": {
    key: "qwen3.7-flash", service: "dashscope", model: "qwen3.7-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: true,
  },
  "qwen3.8-flash": {
    key: "qwen3.8-flash", service: "dashscope", model: "qwen3.8-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: true,
  },
  "mimo-v2.6-flash": {
    key: "mimo-v2.6-flash", service: "mimo", model: "mimo-v2.6-flash",
    baseUrlEnv: "XIAOMI_MIMO_BASE_URL", apiKeyEnv: "XIAOMI_MIMO_API_KEY",
    extra: { thinking: { type: "disabled" } }, jsonMode: true,
  },
  "qwen3-vl-flash": {
    key: "qwen3-vl-flash", service: "dashscope", model: "qwen3-vl-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: false, vision: true,
  },
};

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatJsonOptions<S extends z.ZodType> {
  model: string;
  purpose: string;
  subject: string;
  promptVersion: string;
  system: string;
  user: string | ContentPart[];
  schema: S;
  temperature?: number;
  maxTokens?: number;
  attemptTag?: string;
  timeoutMs?: number;
  /** false: the model answers in its own text format (no JSON mode); `parse` turns it into the schema's input. */
  json?: boolean;
  parse?: (content: string) => unknown;
}

export interface ChatJsonResult<T> {
  data: T;
  receiptId: number;
  reused: boolean;
  model: string;
  usage: Record<string, unknown> | null;
}

export class ModelOutputError extends Error {
  readonly receiptId: number | null;
  readonly reason: "length" | "empty" | "json" | "schema" | null;
  constructor(message: string, receiptId: number | null = null, reason: ModelOutputError["reason"] = null) {
    super(message);
    this.receiptId = receiptId;
    this.reason = reason;
  }
}

function modelCredentials(spec: ModelSpec): { baseUrl: string | null; apiKey: string | null } {
  const baseUrl = credential("models", spec.baseUrlEnv);
  const apiKey = credential("models", spec.apiKeyEnv);
  // A half-configured independent model must never borrow another provider's credential.
  if (spec.key !== "ling-3.1-flash" || baseUrl || apiKey) return { baseUrl, apiKey };
  const fallback = credential("models", "LLM_BASE_URL");
  return lingDefaultMatches(fallback, process.env.LLM_MODEL)
    ? { baseUrl: fallback, apiKey: credential("models", "LLM_API_KEY") }
    : { baseUrl: null, apiKey: null };
}

/** Resolve GLM compatibility from the actual model, including the deployment's default. */
function requestParameters(spec: ModelSpec, opts: { maxTokens?: number; temperature?: number; json?: boolean }) {
  const glm = ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx"].includes(spec.model.toLowerCase());
  const configuredExtra = spec.extra;
  const requestedTokens = Math.max(opts.maxTokens ?? 1500, 512) + (spec.key.endsWith("-think") ? 4000 : 0);
  // Other models retain their existing parameters, extra handling and receipt identity.
  if (!glm) return { glm, extra: configuredExtra, maxTokens: requestedTokens, temperature: opts.temperature ?? 0.2 };
  if (configuredExtra !== undefined && (!configuredExtra || typeof configuredExtra !== "object" || Array.isArray(configuredExtra))) {
    throw new Error("GLM extra must be a JSON object");
  }
  for (const field of ["model", "messages", "stream"]) {
    if (configuredExtra && field in configuredExtra) throw new Error(`Model extra cannot override ${field}`);
  }
  if (configuredExtra && "response_format" in configuredExtra && opts.json !== undefined) {
    const format = configuredExtra.response_format as { type?: unknown } | null;
    if (format?.type !== (opts.json ? "json_object" : "text")) throw new Error("Model extra response_format conflicts with the call's json mode");
  }
  const extra: Record<string, unknown> = { thinking: { type: "enabled" }, reasoning_effort: "low", ...configuredExtra };
  const thinking = extra.thinking;
  if (!thinking || typeof thinking !== "object" || Array.isArray(thinking)) throw new Error("GLM thinking must be an object");
  const options = thinking as Record<string, unknown>;
  if (options.type !== undefined && options.type !== "enabled") throw new Error("GLM-5.3 thinking cannot be disabled");
  if (!["low", "high", "max"].includes(String(extra.reasoning_effort))) throw new Error("GLM-5.3 reasoning_effort must be low, high or max");
  extra.thinking = { type: "enabled", ...options };
  const maxTokens = "max_tokens" in extra ? extra.max_tokens : Math.max(requestedTokens, 4096);
  const temperature = "temperature" in extra ? extra.temperature : opts.temperature ?? 0.2;
  if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 131_072) {
    throw new Error("GLM max_tokens must be a positive integer within the model output limit");
  }
  if (typeof temperature !== "number" || !Number.isFinite(temperature)) throw new Error("GLM temperature must be finite");
  return { glm, extra, maxTokens, temperature };
}

function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1]!;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new ModelOutputError("No JSON object in model output");
  const body = t.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    return JSON.parse(escapeControlCharsInStrings(body));
  }
}

/** Models sometimes emit raw newlines or tabs inside JSON strings (multi-line posts); escape only those. */
export function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      else if (ch < " ") {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function isConnectFailure(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET_BEFORE_SEND", "CERT_HAS_EXPIRED"].includes(code ?? "");
}

export async function chatJson<S extends z.ZodType>(opts: ChatJsonOptions<S>): Promise<ChatJsonResult<z.infer<S>>> {
  const spec = MODELS[opts.model];
  if (!spec) throw new Error(`Unknown model ${opts.model}`);
  if (!config.modelCallsEnabled) throw new Error("Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  const { baseUrl, apiKey } = modelCredentials(spec);
  if (!baseUrl || !apiKey || !spec.model) throw new Error(`Model ${opts.model} is not configured (${spec.baseUrlEnv}, ${spec.apiKeyEnv}${spec.key === "default" ? ", LLM_MODEL" : ""})`);

  assertLingConfiguration(spec.model, baseUrl);
  const ling = isLingModel(spec.model);
  const model = ling ? LING_MODEL : spec.model;
  const { glm, extra, maxTokens, temperature, timeoutMs } = ling
    ? { glm: false, ...lingProfile(spec, opts) }
    : { ...requestParameters(spec, opts), timeoutMs: opts.timeoutMs ?? 120_000 };
  const endpoint = ling ? lingChatEndpoint(baseUrl) : `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const quota = ling ? lingQuota(endpoint, apiKey, timeoutMs) : undefined;
  const userText = typeof opts.user === "string" ? opts.user : JSON.stringify(opts.user);
  const body: Record<string, unknown> = {
    model,
    messages: [
      // A prompt given as one user message (the title/summary prompts) has no system message.
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      // Multimodal parts go through as parts; plain objects are sent as JSON text.
      { role: "user", content: typeof opts.user === "string" || Array.isArray(opts.user) ? opts.user : userText },
    ],
    temperature,
    max_tokens: maxTokens,
    ...(spec.jsonMode && opts.json !== false ? { response_format: { type: "json_object" } } : {}),
    ...(extra ?? {}),
  };

  const receipt = await paidRequest(
    {
      service: spec.service,
      model,
      purpose: opts.purpose,
      subject: opts.subject,
      identity: { model, promptVersion: opts.promptVersion, system: sha256(opts.system), user: sha256(userText), temperature, maxTokens, extra: extra ?? null,
        ...(ling ? { bodyHash: sha256(JSON.stringify(body)) } : {}) },
      requestSummary: { promptVersion: opts.promptVersion, systemHash: sha256(opts.system), userHash: sha256(userText), userChars: userText.length, temperature, maxTokens,
        ...(glm || ling ? { model, bodyHash: sha256(JSON.stringify(body)) } : {}) },
      attemptTag: opts.attemptTag,
      quota,
    },
    async () => {
      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (isConnectFailure(error)) throw new ProviderRejectedError(`connect failed: ${String(error)}`, null, true);
        throw error;
      }
      const text = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new ProviderRejectedError(`HTTP ${res.status}: ${text.slice(0, 500)}`, res.status, retryable,
          ling && res.status === 429 ? retryAfterSeconds(res.headers.get("retry-after")) : undefined);
      }
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text);
        if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Expected a response object");
      } catch {
        json = { unparsable: text.slice(0, 20000) };
      }
      const usage = (json.usage as Record<string, unknown> | undefined) ?? null;
      return {
        response: { ...json, _latencyMs: Date.now() - started },
        requestId: (json.id as string | undefined) ?? res.headers.get("x-request-id"),
        usage,
        cost: null,
      };
    },
  );

  const response = receipt.response as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: Record<string, unknown> };
  const content = response.choices?.[0]?.message?.content ?? "";
  let parsed: z.infer<S>;
  let reason: ModelOutputError["reason"] = ling ? "length" : null;
  try {
    if (glm || ling) {
      if (response.choices?.[0]?.finish_reason === "length") throw new ModelOutputError("Model output truncated (finish_reason=length)");
      if (ling) reason = "empty";
      if (typeof content !== "string" || !content.trim()) throw new ModelOutputError("Model final answer is empty");
    }
    if (ling) reason = "json";
    const input = opts.parse ? opts.parse(content) : extractJson(content);
    if (ling) reason = "schema";
    parsed = opts.schema.parse(input);
  } catch (error) {
    // Unusable output: record it and let a later attempt pay for a fresh answer.
    await rejectReceivedResponse(receipt.receiptId, `unusable output: ${String(error).slice(0, 500)}`);
    throw new ModelOutputError(`Model ${opts.model} returned unusable output for ${opts.subject}: ${String(error).slice(0, 300)}`, receipt.receiptId, reason);
  }
  return { data: parsed, receiptId: receipt.receiptId, reused: receipt.reused, model: spec.key, usage: response.usage ?? null };
}

export async function markReceiptsCompleted(ids: number[]): Promise<void> {
  for (const id of ids) await completeReceipt(sql, id);
}
