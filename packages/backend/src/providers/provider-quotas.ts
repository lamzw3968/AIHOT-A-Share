// Account-scoped admission is coordinated in PostgreSQL. These short transactions never span HTTP.
import { randomUUID } from "node:crypto";
import { sql, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";

export class ProviderDeferredError extends Error {
  readonly retryAfterSeconds: number;
  readonly retryAt: Date;
  constructor(retryAt: Date, now = new Date()) {
    super("Provider quota is busy; request has not been sent");
    this.name = "ProviderDeferredError";
    this.retryAt = retryAt;
    this.retryAfterSeconds = Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000));
  }
}

export interface ProviderQuota {
  /** A one-way digest; never the credential or an account identifier. Not part of receipt identity. */
  key: string;
  intervalMs: number;
  maxInflight: number;
  /** Must outlast the caller's maximum HTTP duration; expiry alone never releases a receipt. */
  leaseMs: number;
}

export function providerQuotaKey(provider: string, endpoint: string, apiKey: string, group?: string): string {
  const url = new URL(endpoint);
  const normalized = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return sha256(stableJson(group ? { provider, group } : { provider, endpoint: normalized, credential: sha256(apiKey) }));
}

function validateQuota(quota: ProviderQuota): void {
  if (!quota.key || !Number.isSafeInteger(quota.intervalMs) || quota.intervalMs < 0 ||
    !Number.isSafeInteger(quota.maxInflight) || quota.maxInflight < 1 ||
    !Number.isSafeInteger(quota.leaseMs) || quota.leaseMs < 1) {
    throw new Error("Provider quota requires a key, a nonnegative integer interval and positive integer inflight/lease limits");
  }
}

/** Called inside the same transaction as receipt/budget reservation. A deferral rolls it all back. */
export async function claimProviderQuota(tx: Db, quota: ProviderQuota): Promise<string> {
  validateQuota(quota);
  await tx`INSERT INTO provider_quotas (quota_key) VALUES (${quota.key}) ON CONFLICT DO NOTHING`;
  const [state] = await tx<{ next_start_at: Date; cooldown_until: Date }[]>`
    SELECT next_start_at, cooldown_until FROM provider_quotas
    WHERE quota_key = ${quota.key} FOR UPDATE`;
  // Read the wall clock after acquiring the row lock: neither transaction-start now() nor a
  // timestamp evaluated while waiting for the lock describes the actual admission time.
  const [clock] = await tx<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const now = clock!.now;
  if (![quota.intervalMs, quota.leaseMs].every((ms) => Number.isFinite(new Date(now.getTime() + ms).getTime()))) {
    throw new Error("Provider quota interval/lease exceeds the supported timestamp range");
  }
  await tx`DELETE FROM provider_quota_leases WHERE quota_key = ${quota.key} AND expires_at <= ${now}`;
  const [leases] = await tx<{ n: number; earliest: Date | null }[]>`
    SELECT count(*)::int AS n, min(expires_at) AS earliest FROM provider_quota_leases WHERE quota_key = ${quota.key}`;
  // A normal request may finish well before its lease: poll at one second instead of parking all
  // other work until the worst-case timeout. A provider cooldown always takes precedence.
  const inflightAt = leases!.n >= quota.maxInflight ? Math.min(leases!.earliest!.getTime(), now.getTime() + 1000) : 0;
  const retryAt = Math.max(state!.next_start_at.getTime(), state!.cooldown_until.getTime(), inflightAt);
  if (retryAt > now.getTime()) throw new ProviderDeferredError(new Date(retryAt), now);
  const id = randomUUID();
  await tx`INSERT INTO provider_quota_leases (id, quota_key, expires_at)
    VALUES (${id}, ${quota.key}, ${new Date(now.getTime() + quota.leaseMs)})`;
  await tx`UPDATE provider_quotas SET next_start_at = ${new Date(now.getTime() + quota.intervalMs)}, updated_at = now()
    WHERE quota_key = ${quota.key}`;
  return id;
}

/** Known responses/rejections release capacity; an unknown network outcome retains its lease. */
export async function finishProviderQuota(tx: Db, quota: ProviderQuota, leaseId: string, succeeded: boolean): Promise<void> {
  await tx`SELECT quota_key FROM provider_quotas WHERE quota_key = ${quota.key} FOR UPDATE`;
  await tx`DELETE FROM provider_quota_leases WHERE id = ${leaseId} AND quota_key = ${quota.key}`;
  // Conservatively space requests from the known completion as well: a delayed process between
  // reservation and HTTP must not cause the next process to burst immediately after it.
  await tx`UPDATE provider_quotas SET next_start_at = greatest(next_start_at,
    clock_timestamp() + ${quota.intervalMs} * interval '1 millisecond'), updated_at = now() WHERE quota_key = ${quota.key}`;
  if (succeeded) await tx`UPDATE provider_quotas SET rate_limit_failures = 0, updated_at = now()
    WHERE quota_key = ${quota.key} AND cooldown_until <= clock_timestamp()`;
}

/** Retry-After accepts delta-seconds and HTTP dates, including an already elapsed date. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Math.ceil(Number(trimmed));
    return Number.isSafeInteger(seconds) && Number.isFinite(new Date(now + seconds * 1000).getTime()) ? seconds : undefined;
  }
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/i.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) && new Date(date).toUTCString().toLowerCase() === trimmed.toLowerCase()
    ? Math.max(0, Math.ceil((date - now) / 1000)) : undefined;
}

/** A real 429 is still a failed paid attempt; its cooldown is shared by every alias/account key. */
export async function coolDownProviderQuota(tx: Db, quota: ProviderQuota, suppliedSeconds?: number): Promise<number> {
  const [state] = await tx<{ rate_limit_failures: number }[]>`
    SELECT rate_limit_failures FROM provider_quotas WHERE quota_key = ${quota.key} FOR UPDATE`;
  const [clock] = await tx<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const count = state!.rate_limit_failures + 1;
  const fallback = Math.min(300, 30 * 2 ** Math.min(count - 1, 4));
  const seconds = suppliedSeconds !== undefined && Number.isFinite(suppliedSeconds) && suppliedSeconds >= 0 &&
    Number.isFinite(new Date(clock!.now.getTime() + Math.ceil(suppliedSeconds) * 1000).getTime())
    ? Math.ceil(suppliedSeconds) : Math.min(300, fallback + Math.floor(Math.random() * Math.min(6, fallback * 0.1 + 1)));
  const [updated] = await tx<{ cooldown_until: Date }[]>`
    UPDATE provider_quotas SET cooldown_until = greatest(cooldown_until, ${new Date(clock!.now.getTime() + seconds * 1000)}),
      rate_limit_failures = ${count}, updated_at = now() WHERE quota_key = ${quota.key} RETURNING cooldown_until`;
  return Math.max(0, Math.ceil((updated!.cooldown_until.getTime() - clock!.now.getTime()) / 1000));
}

/** Maintenance only removes expired admission leases; it never releases unknown logical receipts. */
export async function expireProviderQuotaLeases(): Promise<number> {
  const expired = await sql`DELETE FROM provider_quota_leases WHERE expires_at <= clock_timestamp() RETURNING id`;
  return expired.length;
}
