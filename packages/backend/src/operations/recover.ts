// In-doubt work. A stopped process leaves "pending" receipts and deliveries: they become
// "unknown" and are never re-sent on their own. Only an admin's explicit release, after reconciling
// with the provider, authorizes another send. Admission lease expiry and elapsed time are not evidence
// that a request was unbilled. A released receipt resumes the same logical request and article work.
import { audit, Conflict } from "../audit.ts";
import { sql } from "../db.ts";
import { resumeAfterRelease } from "../jobs/content.ts";
import { retryReleasedReceiptJobs } from "../jobs/queue.ts";
import { markStaleDeliveries } from "../notify/deliver.ts";
import { markStalePendingReceipts, releaseUnknownReceipt } from "../providers/receipts.ts";

async function release(id: number, error: string, actor: string, note: string, billed: boolean) {
  return sql.begin(async (tx) => {
    const receipt = await releaseUnknownReceipt(tx, id, error);
    if (!receipt) return null;
    const requeued = await resumeAfterRelease(receipt, tx);
    await audit(actor, "receipt.release", `receipt:${id}`, note, { status: "unknown" }, { status: "failed", billed, resendAuthorized: true, requeued }, { db: tx });
    return { id, status: "failed", subject: receipt.subject, purpose: receipt.purpose, requeued };
  });
}

/** Admin: reconciles billing AND authorizes another send (possibly billed again), with a reason. */
export async function releaseReceipt(id: number, input: { billed: boolean; note: string }, actor: string) {
  if (typeof input.billed !== "boolean") throw new Error("billed must be a boolean");
  if (typeof input.note !== "string" || !input.note.trim()) throw new Error("note is required");
  const [row] = await sql<{ status: string }[]>`SELECT status FROM receipts WHERE id = ${id}`;
  if (!row) return null;
  if (row.status !== "unknown") throw new Conflict("只有结果未知的回执需要人工核对");
  const error = `人工核账并授权重新发送：${input.billed ? "供应商已计费但结果未取回，接受再次计费风险" : "供应商未计费"}。${input.note}`;
  return release(id, error, actor, input.note, input.billed);
}

/**
 * Compatibility entry point only. No age, lease expiry or sweep can authorize a paid resend.
 * Keep the result shape used by operations consumers; recovery now requires releaseReceipt.
 */
export async function autoReleaseUnknownReceipts(_now = Date.now()) {
  return { released: 0, requeued: 0 };
}

/** ops.recover, every 10 minutes and before the alerts look. */
export async function recoverStaleWork() {
  return { receipts: await markStalePendingReceipts(), released: await autoReleaseUnknownReceipts(), jobs: await retryReleasedReceiptJobs(), deliveries: await markStaleDeliveries() };
}
