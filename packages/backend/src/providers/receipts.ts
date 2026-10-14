// Paid requests (models, SocialData, Jina, Dajiala) go through here.
//
// 1. A logical request has a stable key bound to task, input revision, provider, model, prompt and config.
// 2. Before calling, a placeholder row and an attempt row are persisted; budgets count attempts.
// 3. The raw response is saved before any business write; recovery reuses a received response.
// 4. A request whose outcome is unknown (timeout after sending, crash mid-flight) is not re-sent by the
//    caller. Only an audited admin release after reconciliation authorizes another attempt.
import { sql, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { shutdownSignal } from "../lib/shutdown.ts";
import { setTimeout as delay } from "node:timers/promises";
import { claimProviderQuota, coolDownProviderQuota, finishProviderQuota, ProviderDeferredError, type ProviderQuota } from "./provider-quotas.ts";

export class BudgetExceededError extends Error {
  readonly service: string;
  readonly retryAfterSeconds: number;
  constructor(service: string, window: string, retryAfterSeconds: number) {
    super(`Budget for ${service} exhausted (${window})`);
    this.service = service;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ReceiptBusyError extends Error {}

export class ReceiptUnknownError extends Error {
  readonly receiptId: number;
  constructor(receiptId: number, message: string) {
    super(message);
    this.receiptId = receiptId;
  }
}

/** Raised by a call when the provider clearly did not accept (and will not bill) the request. */
export class ProviderRejectedError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  retryAfterSeconds?: number;
  constructor(message: string, status: number | null, retryable: boolean, retryAfterSeconds?: number) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface CallOutcome {
  response: unknown;
  requestId?: string | null;
  usage?: Record<string, unknown> | null;
  cost?: { amount: number; currency: string; basis: "actual" | "estimated" } | null;
}

export interface ReceiptRequest {
  service: string;
  model?: string | null;
  purpose: string;
  subject?: string | null;
  /** Everything that determines the output. Hashed into the logical key; only a redacted summary is stored. */
  identity: unknown;
  /** Stored for diagnosis; must not contain secrets. */
  requestSummary?: Record<string, unknown>;
  /** Distinguishes an explicit re-run (e.g. admin "re-evaluate") from recovery of the same request. */
  attemptTag?: string;
  /** Admission policy, deliberately outside logical identity and stored request summaries. */
  quota?: ProviderQuota;
}

export interface ReceiptResult {
  receiptId: number;
  response: unknown;
  reused: boolean;
}

const PENDING_STALE_MS = 10 * 60 * 1000;
const LEGACY_AUTO_RELEASE_NOTE = "自动放行：结果未知超过 30 分钟，未核对是否计费";

export function logicalKeyFor(req: ReceiptRequest): string {
  const identity = sha256(stableJson(req.identity));
  return [req.service, req.purpose, req.model ?? "-", identity, req.attemptTag ?? "0"].join(":");
}

interface ReceiptRow {
  id: number;
  status: string;
  response: unknown;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

async function checkBudget(tx: Db, service: string): Promise<void> {
  const [budget] = await tx<{ per_minute: number; per_hour: number; per_day: number }[]>`
    SELECT per_minute, per_hour, per_day FROM budgets WHERE service = ${service}`;
  if (!budget) return; // default rows come with the migrations; a service an operator removed is unlimited
  // Every request sent counts, retries of the same logical request included.
  const [counts] = await tx<{ minute: number; hour: number; day: number }[]>`
    SELECT
      count(*) FILTER (WHERE started_at > now() - interval '1 minute') AS minute,
      count(*) FILTER (WHERE started_at > now() - interval '1 hour') AS hour,
      count(*) AS day
    FROM receipt_attempts
    WHERE service = ${service} AND origin = 'live' AND started_at > now() - interval '1 day'`;
  const c = counts!;
  if (budget.per_minute <= 0 || budget.per_hour <= 0 || budget.per_day <= 0) {
    throw new BudgetExceededError(service, "stopped", 3600);
  }
  if (c.minute >= budget.per_minute) throw new BudgetExceededError(service, "minute", 60);
  if (c.hour >= budget.per_hour) throw new BudgetExceededError(service, "hour", 600);
  if (c.day >= budget.per_day) throw new BudgetExceededError(service, "day", 3600);
}

/**
 * Runs a paid request at most once per logical key and returns its raw response.
 * The caller parses the response and commits business results, then calls completeReceipt.
 */
export async function paidRequest(req: ReceiptRequest, call: () => Promise<CallOutcome>): Promise<ReceiptResult> {
  const logicalKey = logicalKeyFor(req);

  const claim = () => sql.begin(async (tx) => {
    // Serialise budget checks per service so concurrent workers cannot overshoot.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"budget:" + req.service}))`;
    const [existing] = await tx<ReceiptRow[]>`
      SELECT id, status, response, error, created_at, updated_at FROM receipts WHERE logical_key = ${logicalKey} FOR UPDATE`;
    if (existing?.status === "received" || existing?.status === "completed") return { kind: "reuse" as const, row: existing };
    // Finish business writes from saved answers during shutdown, but never reserve or send the
    // next paid page/batch. An answer already in flight still saves below, without this check.
    shutdownSignal.signal.throwIfAborted();
    if (existing) {
      // Upgraded workers may pick up work queued by the old timed release. That release is not
      // authorization, even though it already changed the receipt to failed. Preserve its history.
      if (existing.status === "failed" && existing.error?.startsWith(LEGACY_AUTO_RELEASE_NOTE)) {
        await markUnknown(tx, existing.id, "legacy automatic release requires manual reconciliation and resend authorization");
        return { kind: "unknown" as const, row: existing };
      }
      if (existing.status === "pending") {
        if (Date.now() - existing.updated_at.getTime() < PENDING_STALE_MS) return { kind: "busy" as const, row: existing };
        await markUnknown(tx, existing.id, "placeholder went stale without a recorded result");
        return { kind: "unknown" as const, row: existing };
      }
      if (existing.status === "unknown") return { kind: "unknown" as const, row: existing };
      // failed: the provider did not take the request, or its answer was unusable; a new attempt is allowed.
      await checkBudget(tx, req.service);
      const leaseId = req.quota ? await claimProviderQuota(tx, req.quota) : null;
      const [r] = await tx<{ attempts: number }[]>`
        UPDATE receipts SET status = 'pending', attempts = attempts + 1, error = NULL, updated_at = now() WHERE id = ${existing.id} RETURNING attempts`;
      const attemptId = await startAttempt(tx, existing.id, r!.attempts, req);
      return { kind: "call" as const, id: existing.id, attemptId, leaseId };
    }
    await checkBudget(tx, req.service);
    const leaseId = req.quota ? await claimProviderQuota(tx, req.quota) : null;
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO receipts (logical_key, service, model, purpose, subject, status, request, attempts)
      VALUES (${logicalKey}, ${req.service}, ${req.model ?? null}, ${req.purpose}, ${req.subject ?? null}, 'pending',
              ${tx.json((req.requestSummary ?? {}) as never)}, 1)
      RETURNING id`;
    const attemptId = await startAttempt(tx, row!.id, 1, req);
    return { kind: "call" as const, id: row!.id, attemptId, leaseId };
  });

  // Retry only unsent admission, outside any transaction/connection. A short interval between
  // consecutive steps need not defer the entire task. The HTTP callback is still invoked once;
  // longer cooldowns/contention are reported to the caller for later recovery.
  const waitDeadline = Date.now() + 2100;
  let claimed: Awaited<ReturnType<typeof claim>>;
  for (let waits = 0; ; waits++) {
    try { claimed = await claim(); break; }
    catch (error) {
      if (!(error instanceof ProviderDeferredError)) throw error;
      const waitMs = Math.max(1, error.retryAt.getTime() - Date.now());
      if (waits >= 2 || waitMs > 1100 || Date.now() + waitMs > waitDeadline) throw error;
      await delay(waitMs, undefined, { signal: shutdownSignal.signal });
    }
  }

  if (claimed.kind === "reuse") return { receiptId: claimed.row.id, response: claimed.row.response, reused: true };
  if (claimed.kind === "busy") throw new ReceiptBusyError(`Receipt ${claimed.row.id} is in flight`);
  if (claimed.kind === "unknown") {
    throw unknownOutcome(claimed.row.id);
  }

  const { id: receiptId, attemptId, leaseId } = claimed;
  const started = Date.now();
  let outcome: CallOutcome;
  try {
    outcome = await call();
  } catch (error) {
    const status = error instanceof ProviderRejectedError ? "failed" : "unknown";
    // "unknown": the request may have reached the provider (timeout, reset): do not re-send automatically.
    // Unknown errors may contain URLs, headers, credentials or DB parameters. Persist and expose
    // only a fixed diagnostic and the receipt id; never attach the original error as a cause.
    const message = error instanceof ProviderRejectedError ? error.message.slice(0, 2000) : "provider outcome unknown after send";
    try {
      await sql.begin(async (tx) => {
        if (req.quota && leaseId && error instanceof ProviderRejectedError) {
          if (error.status === 429) error.retryAfterSeconds = await coolDownProviderQuota(tx, req.quota, error.retryAfterSeconds);
          await finishProviderQuota(tx, req.quota, leaseId, false);
        }
        await tx`UPDATE receipts SET status = ${status}, error = ${message}, updated_at = now() WHERE id = ${receiptId}`;
        await tx`UPDATE receipt_attempts SET status = ${status}, error = ${message}, latency_ms = ${Date.now() - started}, finished_at = now() WHERE id = ${attemptId}`;
      });
    } catch {
      // Even a failed status write must identify the reserved receipt to queue recovery.
      throw unknownOutcome(receiptId);
    }
    if (status === "unknown") throw unknownOutcome(receiptId);
    throw error; // preserve rejection/429 classification and cooldown for existing callers
  }

  try {
    await sql.begin(async (tx) => {
      if (req.quota && leaseId) await finishProviderQuota(tx, req.quota, leaseId, true);
      await tx`
        UPDATE receipts SET
          status = 'received',
          response = ${tx.json((outcome.response ?? null) as never)},
          request_id = ${outcome.requestId ?? null},
          usage = ${outcome.usage ? tx.json(outcome.usage as never) : null},
          cost = ${outcome.cost?.amount ?? null},
          currency = ${outcome.cost?.currency ?? null},
          cost_basis = ${outcome.cost?.basis ?? null},
          received_at = now(),
          updated_at = now()
        WHERE id = ${receiptId}`;
      await tx`
        UPDATE receipt_attempts SET
          status = 'received', request_id = ${outcome.requestId ?? null}, usage = ${outcome.usage ? tx.json(outcome.usage as never) : null},
          cost = ${outcome.cost?.amount ?? null}, currency = ${outcome.cost?.currency ?? null}, cost_basis = ${outcome.cost?.basis ?? null},
          latency_ms = ${Date.now() - started}, finished_at = now()
        WHERE id = ${attemptId}`;
    });
  } catch {
    // A response may have been paid for even if encoding/storage (or its commit acknowledgement)
    // failed. Best effort only: a DB outage leaves pending, which still blocks sending and becomes
    // unknown on recovery. Never downgrade a received/completed answer after an ambiguous commit.
    await sql.begin(async (tx) => {
      const changed = await tx`UPDATE receipts SET status = 'unknown', error = 'response persistence outcome unknown', updated_at = now()
        WHERE id = ${receiptId} AND status = 'pending' RETURNING id`;
      if (changed.length) await tx`UPDATE receipt_attempts SET status = 'unknown', error = 'response persistence outcome unknown',
        latency_ms = ${Date.now() - started}, finished_at = now() WHERE id = ${attemptId} AND status = 'pending'`;
    }).catch(() => {});
    throw unknownOutcome(receiptId);
  }
  return { receiptId, response: outcome.response, reused: false };
}

function unknownOutcome(receiptId: number): ReceiptUnknownError {
  return new ReceiptUnknownError(receiptId, `Receipt ${receiptId} has an unknown outcome; reconcile with the provider and explicitly authorize a resend from the admin`);
}

async function startAttempt(tx: Db, receiptId: number, attempt: number, req: ReceiptRequest): Promise<number> {
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status) VALUES (${receiptId}, ${attempt}, ${req.service}, ${req.model ?? null}, 'pending')
    RETURNING id`;
  return row!.id;
}

async function markUnknown(tx: Db, receiptId: number, reason: string) {
  await tx`UPDATE receipts SET status = 'unknown', error = ${reason}, updated_at = now() WHERE id = ${receiptId}`;
  await tx`UPDATE receipt_attempts SET status = 'unknown', error = ${reason}, finished_at = now() WHERE receipt_id = ${receiptId} AND status = 'pending'`;
}

/**
 * Placeholders left behind by a process that stopped mid-request (crash, kill) become "unknown", so
 * they wait for reconciliation and explicit authorization even when nothing retries them.
 */
export async function markStalePendingReceipts(): Promise<number> {
  const reason = "placeholder went stale without a recorded result";
  return sql.begin(async (tx) => {
    // Recheck status and age when the row lock is acquired: a response may commit while we wait.
    const stale = await tx<{ id: number }[]>`
      UPDATE receipts SET status = 'unknown', error = ${reason}, updated_at = now()
      WHERE status = 'pending' AND updated_at < ${new Date(Date.now() - PENDING_STALE_MS)} RETURNING id`;
    if (stale.length) {
      await tx`UPDATE receipt_attempts SET status = 'unknown', error = ${reason}, finished_at = now()
               WHERE receipt_id IN ${tx(stale.map((r) => r.id))} AND status = 'pending'`;
    }
    return stale.length;
  });
}

/**
 * Releases an unknown receipt: marked failed, so the next attempt of its request calls again (who
 * releases and when: operations/recover.ts). Null when the receipt is not, or no longer, unknown.
 */
export async function releaseUnknownReceipt(db: Db, id: number, error: string): Promise<{ subject: string | null; purpose: string } | null> {
  const [released] = await db<{ subject: string | null; purpose: string }[]>`
    UPDATE receipts SET status = 'failed', error = ${error}, updated_at = now() WHERE id = ${id} AND status = 'unknown' RETURNING subject, purpose`;
  // The attempt's outcome is still unknown. Billing reconciliation and permission for a NEW attempt
  // belong in the atomic receipt.release audit, not in a rewrite of the historical paid attempt.
  return released ?? null;
}

export async function completeReceipt(db: Db, receiptId: number): Promise<void> {
  await db`UPDATE receipts SET status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now() WHERE id = ${receiptId}`;
}

/** Marks a received response that could not be used (e.g. unparsable) so a fresh attempt can be made. */
export async function rejectReceivedResponse(receiptId: number, reason: string): Promise<void> {
  await sql`UPDATE receipts SET status = 'failed', error = ${reason.slice(0, 2000)}, updated_at = now() WHERE id = ${receiptId}`;
}
