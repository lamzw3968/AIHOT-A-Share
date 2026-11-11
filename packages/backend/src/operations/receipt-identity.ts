// Operator review of a single historical Ling identity conflict. This does not release either
// receipt or authorize a retry of the old request. Evidence is checked but never persisted.
import { audit, Conflict } from "../audit.ts";
import { sql } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { isLingIdentityV2, logicalKeyFor } from "../providers/receipts.ts";

type ConflictRow = {
  id: number; receipt_id: number; receipt_key: string; receipt_wire_hash: string; receipt_attempts: number;
  request_key: string; request_identity: unknown; request_tag: string; state: string; expires_at: Date | null;
};
type Receipt = { id: number; service: string; model: string | null; purpose: string; logical_key: string;
  status: string; attempts: number; request: Record<string, unknown> | null; has_unknown: boolean };

function invalid(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function reasonText(input: unknown): string {
  if (typeof input !== "string" || input.trim().length < 8 || input.length > 1000) throw invalid("A review reason of 8 to 1000 characters is required");
  return input.trim();
}

async function serviceFor(id: number): Promise<string | null> {
  if (!Number.isSafeInteger(id) || id < 1) throw invalid("Invalid identity conflict id");
  const [row] = await sql<{ service: string }[]>`SELECT r.service FROM receipt_identity_conflicts c JOIN receipts r ON r.id = c.receipt_id WHERE c.id = ${id}`;
  return row?.service ?? null;
}

/** Digest-only data required to select and review a blocked request. */
export async function listReceiptIdentityConflicts() {
  const conflicts = await sql`SELECT id, receipt_id, receipt_key, receipt_wire_hash, receipt_attempts,
    request_key, request_identity, request_tag, state, actor, reason, authorized_at, expires_at, revoked_at, revoked_by, created_at, updated_at
    FROM receipt_identity_conflicts ORDER BY updated_at DESC LIMIT 100`;
  return { conflicts };
}

/** Verify an exact historical wire body and identity preimage without storing either. */
export async function authorizeReceiptIdentityConflict(id: number, input: {
  oldIdentity: unknown; wireBody: string; reason: string; expiresAt: string;
}, actor: string) {
  const reason = reasonText(input?.reason);
  if (typeof actor !== "string" || !actor.trim()) throw new Error("Administrator identity is required");
  if (typeof input?.wireBody !== "string" || Buffer.byteLength(input.wireBody, "utf8") > 1_000_000) throw invalid("Valid historical wire evidence is required");
  if (!input.oldIdentity || typeof input.oldIdentity !== "object" || Array.isArray(input.oldIdentity)) throw invalid("Valid historical identity evidence is required");
  if (typeof input.expiresAt !== "string") throw invalid("A bounded expiry is required");
  const expiry = new Date(input.expiresAt);
  if (!Number.isFinite(expiry.getTime())) throw invalid("A bounded expiry is required");
  let body: unknown;
  try { body = JSON.parse(input.wireBody); } catch { throw invalid("Historical wire evidence must be JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Historical wire evidence must be a JSON object");
  const service = await serviceFor(id);
  if (!service) return null;
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"budget:" + service}))`;
    const [c] = await tx<ConflictRow[]>`SELECT * FROM receipt_identity_conflicts WHERE id = ${id} FOR UPDATE`;
    if (!c) return null;
    const [r] = await tx<Receipt[]>`SELECT r.id, r.service, r.model, r.purpose, r.logical_key, r.status, r.attempts, r.request,
      EXISTS (SELECT 1 FROM receipt_attempts a WHERE a.receipt_id = r.id AND a.status = 'unknown') AS has_unknown
      FROM receipts r WHERE r.id = ${c.receipt_id} FOR UPDATE`;
    if (!r || r.service !== service || r.logical_key !== c.receipt_key || r.attempts !== c.receipt_attempts ||
        !r.has_unknown || !["unknown", "failed"].includes(r.status) || r.request?.bodyHash !== c.receipt_wire_hash) {
      throw new Conflict("Historical receipt changed; review the current conflict again");
    }
    const [clock] = await tx<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    const delta = expiry.getTime() - clock!.now.getTime();
    if (delta < 60_000 || delta > 24 * 60 * 60_000) throw invalid("Expiry must be between one minute and 24 hours");
    if (c.state === "authorized" && c.expires_at && c.expires_at > clock!.now) throw new Conflict("This identity conflict already has an active authorization");
    const oldIdentity = input.oldIdentity as Record<string, unknown>;
    const canonical = sha256(stableJson(body));
    const oldKey = logicalKeyFor({ service: r.service, model: r.model, purpose: r.purpose, identity: oldIdentity, attemptTag: c.request_tag });
    if (oldKey !== r.logical_key || oldIdentity.bodyHash !== canonical || sha256(input.wireBody) !== c.receipt_wire_hash ||
        oldIdentity.model !== r.model || (body as Record<string, unknown>).model !== r.model ||
        !isLingIdentityV2(c.request_identity) || c.request_identity.model !== r.model ||
        logicalKeyFor({ service: r.service, model: r.model, purpose: r.purpose, identity: c.request_identity, attemptTag: c.request_tag }) !== c.request_key ||
        c.request_identity.bodyHash === canonical) {
      throw new Conflict("Evidence cannot prove these are distinct historical and waiting requests");
    }
    await tx`UPDATE receipt_identity_conflicts SET state = 'authorized', actor = ${actor}, reason = ${reason},
      authorized_at = ${clock!.now}, expires_at = ${expiry}, revoked_at = NULL, revoked_by = NULL, updated_at = now() WHERE id = ${id}`;
    await audit(actor, "receipt.identity.authorize", `receipt-identity:${id}`, reason, null,
      { receiptId: r.id, receiptKey: r.logical_key, requestKey: c.request_key, wireHash: c.receipt_wire_hash,
        historicalBodyHash: canonical, waitingBodyHash: c.request_identity.bodyHash, receiptAttempts: r.attempts, expiresAt: expiry.toISOString() }, { db: tx });
    return { id, state: "authorized", expiresAt: expiry.toISOString() };
  });
}

/** Revocation serializes with admission; a request already admitted cannot be unsent. */
export async function revokeReceiptIdentityConflict(id: number, input: { reason: string }, actor: string) {
  const reason = reasonText(input?.reason);
  if (typeof actor !== "string" || !actor.trim()) throw new Error("Administrator identity is required");
  const service = await serviceFor(id);
  if (!service) return null;
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"budget:" + service}))`;
    const [c] = await tx<ConflictRow[]>`SELECT * FROM receipt_identity_conflicts WHERE id = ${id} FOR UPDATE`;
    if (!c) return null;
    if (c.state !== "authorized") throw new Conflict("This identity conflict is not authorized");
    await tx`UPDATE receipt_identity_conflicts SET state = 'revoked', revoked_at = now(), revoked_by = ${actor}, updated_at = now() WHERE id = ${id}`;
    await audit(actor, "receipt.identity.revoke", `receipt-identity:${id}`, reason,
      { receiptId: c.receipt_id, requestKey: c.request_key, state: c.state }, { state: "revoked" }, { db: tx });
    return { id, state: "revoked", expiresAt: c.expires_at?.toISOString() ?? null };
  });
}
