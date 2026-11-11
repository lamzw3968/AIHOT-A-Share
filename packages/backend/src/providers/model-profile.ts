// Only the verified Ling 3.1 Flash protocol belongs here; other providers keep their existing paths.
import type { ModelSpec } from "./llm.ts";
import { providerQuotaKey, type ProviderQuota } from "./provider-quotas.ts";

export const LING_MODEL = "Ling-3.1-flash";

export function isLingModel(model: string): boolean { return model.toLowerCase() === LING_MODEL.toLowerCase(); }

function positiveNumber(name: string, fallback: number, integer = false): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${name} must be a positive ${integer ? "integer" : "number"}`);
  }
  return value;
}

/** Both configuration forms resolve to one wire route and one account quota key. */
export function lingChatEndpoint(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new Error("Ling endpoint must be an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Ling endpoint must use HTTP(S) without credentials, query or fragment");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (url.hostname === "api.ant-ling.com" && (url.origin !== "https://api.ant-ling.com" || !["/v1", "/v1/chat/completions"].includes(path))) {
    throw new Error("Official Ling endpoint must be https://api.ant-ling.com/v1 or its chat/completions route");
  }
  if (url.hostname === "open.bigmodel.cn") throw new Error("Ling model and official provider endpoint do not match");
  url.pathname = path.endsWith("/chat/completions") ? path : `${path}/chat/completions`;
  return url.toString();
}

/** A named preset borrows default credentials only from the verified official model/route pair. */
export function lingDefaultMatches(baseUrl: string | null, model: string | undefined): boolean {
  if (!model || !isLingModel(model)) return false;
  try {
    const endpoint = new URL(lingChatEndpoint(baseUrl ?? ""));
    return endpoint.origin === "https://api.ant-ling.com" && endpoint.pathname === "/v1/chat/completions";
  } catch { return false; }
}

export function assertLingConfiguration(model: string, endpoint: string): void {
  if (isLingModel(model)) { lingChatEndpoint(endpoint); return; }
  // Do not extend a verified model's settings to unverified Ling/Ring variants. Existing GLM and
  // other compatible models retain their endpoint and parameter behavior.
  if (/^(?:ling|ring)-/i.test(model)) {
    let official = false;
    try { official = new URL(endpoint).hostname === "api.ant-ling.com"; } catch { /* legacy path */ }
    if (official) throw new Error("Unsupported official Ling/Ring model; only Ling-3.1-flash is supported");
  }
}

export function lingProfile(spec: ModelSpec, opts: { maxTokens?: number; temperature?: number; timeoutMs?: number; json?: boolean }) {
  if (!isLingModel(spec.model)) throw new Error("Ling profile supports only Ling-3.1-flash");
  const extra = spec.extra;
  if (extra !== undefined && (!extra || typeof extra !== "object" || Array.isArray(extra))) {
    throw new Error("Ling extra must be a JSON object");
  }
  for (const field of ["model", "messages", "stream"]) {
    if (extra && field in extra) throw new Error(`Model extra cannot override ${field}`);
  }
  // Ling 3.1 has no verified thinking switch; GLM and earlier Ling/Ring flags must not leak in.
  for (const field of ["thinking", "reasoning", "reasoning_effort", "enable_thinking", "thinking_budget"]) {
    if (extra && field in extra) throw new Error(`Ling-3.1-flash does not support ${field}`);
  }
  if (extra && "response_format" in extra) {
    const format = extra.response_format as { type?: unknown } | null;
    if (!format || typeof format !== "object" || Array.isArray(format) || !["json_object", "text"].includes(String(format.type))) {
      throw new Error("Ling response_format must select json_object or text");
    }
    if (opts.json !== undefined && format.type !== (opts.json ? "json_object" : "text")) {
      throw new Error("Model extra response_format conflicts with the call's json mode");
    }
  }
  const floor = positiveNumber("ANT_LING_MIN_OUTPUT_TOKENS", 4096, true);
  const requestedTokens = Math.max(opts.maxTokens ?? 1500, 512);
  // Explicit operator max_tokens wins. No unverified model-specific upper bound is assumed.
  const maxTokens = extra && "max_tokens" in extra ? extra.max_tokens : Math.max(requestedTokens, floor);
  const temperature = extra && "temperature" in extra ? extra.temperature : opts.temperature ?? 0.2;
  if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new Error("Ling max_tokens must be a positive safe integer");
  }
  if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
    throw new Error("Ling temperature must be between 0 and 1");
  }
  if (extra && "top_p" in extra && (typeof extra.top_p !== "number" || !Number.isFinite(extra.top_p) || extra.top_p <= 0 || extra.top_p > 1)) {
    throw new Error("Ling top_p must be greater than 0 and at most 1");
  }
  const requestedTimeout = opts.timeoutMs ?? 85_000;
  if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout <= 0) throw new Error("Ling timeoutMs must be a positive integer");
  return { extra, maxTokens, temperature, timeoutMs: Math.min(requestedTimeout, 85_000) };
}

export function lingQuota(endpoint: string, apiKey: string, timeoutMs: number): ProviderQuota {
  const qps = positiveNumber("ANT_LING_QPS", 1);
  const intervalMs = Math.max(1, Math.ceil(1000 / qps));
  if (!Number.isSafeInteger(intervalMs)) throw new Error("ANT_LING_QPS produces an unsupported quota interval");
  const maxInflight = positiveNumber("ANT_LING_MAX_INFLIGHT", 1, true);
  const group = process.env.ANT_LING_QUOTA_GROUP?.trim();
  return {
    key: providerQuotaKey("ant-ling", lingChatEndpoint(endpoint), apiKey, group),
    intervalMs,
    maxInflight,
    leaseMs: timeoutMs + 15_000,
  };
}
