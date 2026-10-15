// Budget tests own their consumption window. Other tests' live attempts may age out while a
// subprocess starts, so park only their origin and restore every original row in finally.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { sql } from "@aihot/backend/db";

interface Attempt {
  id: number;
  receipt_id: number;
  origin: string;
  status: string;
  started_at: Date;
}

export async function withIsolatedBudget<T>(service: string, limit: number, fn: () => Promise<T>): Promise<T> {
  const saved = await sql.begin(async (tx) => {
    const [budget] = await tx<{ per_minute: number; per_hour: number; per_day: number }[]>`
      SELECT per_minute, per_hour, per_day FROM budgets WHERE service = ${service} FOR UPDATE`;
    // Always exercise nonempty history, including attempts beside each rolling-window boundary.
    // These are local ledger fixtures, never provider calls, and remain available for diagnosis.
    const [receipt] = await tx<{ id: number }[]>`
      INSERT INTO receipts (logical_key, service, purpose, subject, status, attempts, origin)
      VALUES (${`budget-history-${tag()}`}, ${service}, 'budget_history_fixture', 'isolated budget history', 'completed', 3, 'imported')
      RETURNING id`;
    for (const [index, age] of ["59 seconds", "59 minutes 59 seconds", "23 hours 59 minutes 59 seconds"].entries()) {
      await tx`INSERT INTO receipt_attempts (receipt_id, attempt, service, status, started_at)
        VALUES (${receipt!.id}, ${index + 1}, ${service}, 'received', now() - ${age}::interval)`;
    }
    const attempts = await tx<Attempt[]>`
      SELECT id, receipt_id, origin, status, started_at FROM receipt_attempts
      WHERE service = ${service} AND origin = 'live' ORDER BY id FOR UPDATE`;
    assert.equal(attempts.filter((row) => row.receipt_id === receipt!.id).length, 3, "controlled live history is present even in an empty database");
    await tx`UPDATE receipt_attempts SET origin = 'imported' WHERE id = ANY(${attempts.map((row) => row.id)}::bigint[])`;
    await tx`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, ${limit}, ${limit}, ${limit})
      ON CONFLICT (service) DO UPDATE SET per_minute = ${limit}, per_hour = ${limit}, per_day = ${limit}`;
    return { budget, attempts };
  });
  try {
    const result = await fn();
    const [live] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM receipt_attempts WHERE service = ${service} AND origin = 'live'`;
    assert.equal(live!.n, limit, "the test's new requests remain live and consume the fixed allowance");
    return result;
  } finally {
    await sql.begin(async (tx) => {
      await tx`UPDATE receipt_attempts SET origin = 'live' WHERE id = ANY(${saved.attempts.map((row) => row.id)}::bigint[])`;
      if (saved.budget) await tx`UPDATE budgets SET per_minute = ${saved.budget.per_minute}, per_hour = ${saved.budget.per_hour}, per_day = ${saved.budget.per_day}
        WHERE service = ${service}`;
      else await tx`DELETE FROM budgets WHERE service = ${service}`;
    });
    const restored = await sql<Attempt[]>`
      SELECT id, receipt_id, origin, status, started_at FROM receipt_attempts
      WHERE id = ANY(${saved.attempts.map((row) => row.id)}::bigint[]) ORDER BY id`;
    assert.deepEqual([...restored], [...saved.attempts], "every historical attempt regains its exact origin, state, receipt and timestamp");
    const [budget] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`
      SELECT per_minute, per_hour, per_day FROM budgets WHERE service = ${service}`;
    assert.deepEqual(budget, saved.budget, "the original service budget is restored");
  }
}
