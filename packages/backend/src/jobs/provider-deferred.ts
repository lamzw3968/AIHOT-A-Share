// Unsent quota waits park durably and complete the old claim atomically. Continuations use only
// pg-boss's public API; a sent rejection (including 429) still takes its normal failure path.
import type { JobWithMetadata, PgBoss, SendOptions } from "pg-boss";
import { sql, type Db } from "../db.ts";
import { shutdownSignal } from "../lib/shutdown.ts";
import { ProviderDeferredError } from "../providers/provider-quotas.ts";
import { ProviderRejectedError } from "../providers/receipts.ts";

export { ProviderDeferredError } from "../providers/provider-quotas.ts";

/** Both conditions stop a batch, but only an unsent admission wait preserves its failure budget. */
export function isProviderPause(error: unknown): error is ProviderDeferredError | ProviderRejectedError {
  return error instanceof ProviderDeferredError || (error instanceof ProviderRejectedError && error.status === 429);
}

interface DeferredJob {
  id: string;
  current_job_id: string;
  queue_name: string;
  payload: object;
  options: SendOptions;
  failures_consumed: number;
  remaining_retries: number;
  expires_at: Date;
  original_created_at: Date;
  resume_at: Date;
  status: "waiting" | "dispatched" | "finished" | "expired";
}

function queueDb(tx: Db) {
  return { executeSql: async (text: string, values?: unknown[]) => ({ rows: await tx.unsafe(text, (values ?? []) as never[]) }) };
}

function dispatchFailure(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error && /^[A-Z0-9_]{1,40}$/.test(String(error.code)) ? ` ${String(error.code)}` : "";
  const message = (error instanceof Error ? error.message : "unknown dispatch error")
    .replace(/(?:https?|postgres(?:ql)?):\/\/\S+/gi, "[endpoint]")
    .replace(/(api[-_ ]?key|authorization|password|token|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ").slice(0, 240);
  return `dispatch failed (${error instanceof Error ? error.name : "error"}${code}): ${message}`;
}

function continuationOptions<T>(job: JobWithMetadata<T>): SendOptions {
  return {
    priority: job.priority, singletonKey: job.singletonKey ?? undefined,
    retryDelay: job.retryDelay, retryBackoff: job.retryBackoff,
    ...(job.retryBackoff && job.retryDelayMax != null ? { retryDelayMax: job.retryDelayMax } : {}),
    expireInSeconds: job.expireInSeconds, deleteAfterSeconds: job.deleteAfterSeconds,
    ...(job.heartbeatSeconds != null ? { heartbeatSeconds: job.heartbeatSeconds } : {}),
    ...(job.groupId != null ? { group: { id: job.groupId, ...(job.groupTier != null ? { tier: job.groupTier } : {}) } } : {}),
    ...(job.deadLetter ? { deadLetter: job.deadLetter } : {}),
  };
}

async function park<T>(boss: PgBoss, job: JobWithMetadata<T>, error: ProviderDeferredError): Promise<object> {
  // pg-boss exposes the bucket timestamp but not its interval. Recreating a throttled/debounced
  // job would silently weaken deduplication; current AIHOT queues use policy + singletonKey only.
  if (job.singletonOn != null) throw new Error("provider deferral cannot preserve a time-window singleton");
  return sql.begin(async (tx) => {
    const [previous] = await tx<DeferredJob[]>`SELECT * FROM provider_deferred_jobs WHERE current_job_id = ${job.id} FOR UPDATE`;
    const expiresAt = previous?.expires_at ?? new Date(job.keepUntil);
    const [clock] = await tx<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    const resumeAt = new Date(Math.max(clock!.now.getTime(), error.retryAt.getTime()));
    if (!Number.isFinite(resumeAt.getTime()) || !Number.isFinite(expiresAt.getTime())) throw new Error("invalid provider deferral deadline");
    const expired = expiresAt <= resumeAt;
    const id = previous?.id ?? job.id;
    const remaining = Math.max(0, job.retryLimit - job.retryCount);
    const failures = (previous?.failures_consumed ?? 0) + job.retryCount;
    const result = { state: expired ? "provider-deferred-expired" : "provider-deferred", retryAt: resumeAt.toISOString(), deferredId: id };
    await tx`
      INSERT INTO provider_deferred_jobs
        (id, current_job_id, queue_name, payload, options, failures_consumed, remaining_retries, expires_at, original_created_at, resume_at, status, reason)
      VALUES (${id}, ${job.id}, ${job.name}, ${tx.json(job.data as never)}, ${tx.json(continuationOptions(job) as never)},
              ${failures}, ${remaining}, ${expiresAt}, ${previous?.original_created_at ?? job.createdOn}, ${resumeAt}, ${expired ? "expired" : "waiting"}, ${error.message})
      ON CONFLICT (id) DO UPDATE SET failures_consumed = EXCLUDED.failures_consumed, remaining_retries = EXCLUDED.remaining_retries,
        resume_at = EXCLUDED.resume_at, status = EXCLUDED.status, reason = EXCLUDED.reason, updated_at = now()`;
    // An expired/shutdown/lost claim cannot leave a parked copy behind. The insert and completion
    // roll back together. fetch() supplies no signal; the real work() handler always supplies one.
    shutdownSignal.signal.throwIfAborted();
    job.signal?.throwIfAborted();
    const completed = await boss.complete(job.name, job.id, result, { db: queueDb(tx) });
    // pg-boss 12.34's type omits its runtime response fields. Its actual contract is covered by
    // the database/worker tests, including the worker's harmless second auto-completion.
    if (!("affected" in completed) || completed.affected !== 1) throw new Error("provider deferral lost its queue claim");
    return result;
  });
}

/** Only queue.ts's existing receipt.release audit path may reopen a terminal continuation. */
export async function restoreReleasedProviderJob(tx: Db, jobId: string): Promise<void> {
  await tx`UPDATE provider_deferred_jobs SET status = 'dispatched', reason = NULL, updated_at = now()
    WHERE current_job_id = ${jobId} AND status = 'finished' AND expires_at > clock_timestamp()`;
}

/** Shared by business and cron queues; no transaction or database lock spans the handler/HTTP. */
export async function runProviderAwareJob<T, R>(boss: PgBoss, job: JobWithMetadata<T>, handler: (createdAt: Date) => Promise<R>): Promise<R | object> {
  const [continuation] = await sql<DeferredJob[]>`SELECT * FROM provider_deferred_jobs WHERE current_job_id = ${job.id}`;
  if (continuation && (continuation.status !== "dispatched" || continuation.expires_at <= new Date())) {
    if (continuation.status === "dispatched") await sql`
      UPDATE provider_deferred_jobs SET status = 'expired', reason = 'original task deadline elapsed', updated_at = now()
      WHERE id = ${continuation.id} AND current_job_id = ${job.id} AND status = 'dispatched'`;
    return { state: continuation.status === "finished" ? "provider-deferred-finished" : "provider-deferred-expired" };
  }
  try {
    const result = await handler(continuation?.original_created_at ?? job.createdOn);
    if (continuation) await sql`UPDATE provider_deferred_jobs SET status = 'finished', reason = NULL, updated_at = now()
      WHERE id = ${continuation.id} AND current_job_id = ${job.id} AND status = 'dispatched'`;
    return result;
  } catch (error) {
    if (error instanceof ProviderDeferredError && !shutdownSignal.signal.aborted && !job.signal?.aborted) return park(boss, job, error);
    // In particular, neither a real 429 nor ReceiptUnknownError is turned into an unsent wait.
    // Retry payload/tag remains unchanged, so receipts still block resending an unknown request.
    if (continuation && job.retryCount >= job.retryLimit) await sql`
      UPDATE provider_deferred_jobs SET status = 'finished', reason = ${String(error).slice(0, 500)}, updated_at = now()
      WHERE id = ${continuation.id} AND current_job_id = ${job.id} AND status = 'dispatched'`;
    throw error;
  }
}

/** Restart-safe, bounded dispatch. Each row owns its short transaction, including pg-boss.send. */
export async function resumeDeferredProviderJobs(boss: PgBoss, now = new Date(), limit = 100): Promise<{ dispatched: number; waiting: number; expired: number; finished: number }> {
  if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid provider resume bounds");
  const result = { dispatched: 0, waiting: 0, expired: 0, finished: 0 };
  if (shutdownSignal.signal.aborted) return result;
  const expired = await sql<{ id: string }[]>`
    UPDATE provider_deferred_jobs SET status = 'expired', reason = 'original task deadline elapsed', updated_at = now()
    WHERE status IN ('waiting', 'dispatched') AND expires_at <= ${now} RETURNING id`;
  result.expired = expired.length;
  // A cancelled/failed/missing queue job must not leave its coordination row dispatched forever.
  // Missing jobs are closed for diagnosis, never blindly resent: they may already have been paid.
  await sql.begin(async (tx) => {
    const rows = await tx<DeferredJob[]>`
      SELECT * FROM provider_deferred_jobs WHERE status = 'dispatched'
      ORDER BY updated_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    for (const row of rows) {
      const job = await boss.getJobById(row.queue_name, row.current_job_id, { db: queueDb(tx) });
      const terminal = !job || ["completed", "failed", "cancelled"].includes(job.state);
      await tx`UPDATE provider_deferred_jobs SET status = ${terminal ? "finished" : "dispatched"},
        reason = ${terminal ? (job ? `queue job ${job.state}` : "queue job missing; inspect receipts before any manual recovery") : null}, updated_at = now()
        WHERE id = ${row.id}`;
      if (terminal) result.finished++;
    }
  });
  // Keep a week of terminal coordination evidence beyond original expiry. This retention touches
  // neither business data nor paid receipts, and never removes an outstanding continuation.
  await sql`DELETE FROM provider_deferred_jobs WHERE id IN (
    SELECT id FROM provider_deferred_jobs WHERE status IN ('finished', 'expired')
      AND expires_at < ${now} - interval '7 days' ORDER BY expires_at LIMIT 1000)`;
  for (let n = 0; n < limit && !shutdownSignal.signal.aborted; n++) {
    let candidateId: string | undefined;
    try {
      const outcome = await sql.begin(async (tx) => {
        const [row] = await tx<DeferredJob[]>`
          SELECT * FROM provider_deferred_jobs WHERE status = 'waiting' AND resume_at <= ${now}
          ORDER BY resume_at, created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
        if (!row) return "empty" as const;
        candidateId = row.id;
        // Never extend the first job's absolute keepUntil, including time spent waiting for locks.
        const [clock] = await tx<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        const startAfter = new Date(Math.max(now.getTime(), clock!.now.getTime()));
        const retentionSeconds = Math.floor((row.expires_at.getTime() - startAfter.getTime()) / 1000);
        if (retentionSeconds < 1) {
          await tx`UPDATE provider_deferred_jobs SET status = 'expired', reason = 'original task deadline elapsed', updated_at = now() WHERE id = ${row.id}`;
          return "expired" as const;
        }
        shutdownSignal.signal.throwIfAborted();
        const id = await boss.send(row.queue_name, row.payload, {
          ...row.options, retryLimit: row.remaining_retries, startAfter, retentionSeconds, db: queueDb(tx),
        });
        if (!id) {
          await tx`UPDATE provider_deferred_jobs SET resume_at = ${new Date(startAfter.getTime() + 60_000)},
            reason = 'queue unavailable or singleton conflict; waiting to resume', updated_at = now() WHERE id = ${row.id}`;
          return "waiting" as const;
        }
        await tx`UPDATE provider_deferred_jobs SET current_job_id = ${id}, status = 'dispatched', reason = NULL, updated_at = now() WHERE id = ${row.id}`;
        return "dispatched" as const;
      });
      if (outcome === "empty") break;
      result[outcome]++;
    } catch (error) {
      if (!candidateId) throw error;
      // send + pointer update were atomic. If commit acknowledgement was lost and it did commit,
      // the status predicate prevents this diagnostic update from reversing the dispatch.
      await sql`UPDATE provider_deferred_jobs SET resume_at = ${new Date(Math.max(now.getTime(), Date.now()) + 60_000)},
        reason = ${dispatchFailure(error)}, updated_at = now()
        WHERE id = ${candidateId} AND status = 'waiting'`;
      result.waiting++;
      if (shutdownSignal.signal.aborted) break;
    }
  }
  return result;
}
