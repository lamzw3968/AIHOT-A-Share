import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { PgBoss, type JobWithMetadata } from "pg-boss";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, recordRun, retryReleasedReceiptJobs, stopBoss } from "@aihot/backend/jobs/queue";
import { ProviderDeferredError, isProviderPause, resumeDeferredProviderJobs, runProviderAwareJob } from "@aihot/backend/jobs/provider-deferred";
import { paidRequest, ProviderRejectedError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { releaseReceipt } from "@aihot/backend/operations/recover";
import { dueDaily, dueMonthly, dueWeekly } from "@aihot/backend/reports/compose";

after(async () => { await stopBoss(); await closeDb(); });

async function fixture(retryLimit = 3, retentionSeconds = 300) {
  const boss = await getBoss();
  const queue = `deferred.${tag()}`;
  await boss.createQueue(queue, { policy: "short", retryLimit, retryDelay: 0, expireInSeconds: 60 });
  const payload = { articleId: tag(), attemptTag: `manual-${tag()}` };
  const id = await boss.send(queue, payload, { singletonKey: payload.articleId, priority: 19, retentionSeconds });
  assert.ok(id);
  const [job] = await boss.fetch<typeof payload>(queue, { includeMetadata: true });
  assert.ok(job);
  return { boss, queue, payload, id, job };
}

async function row(id: string) {
  const [r] = await sql<{ current_job_id: string; failures_consumed: number; remaining_retries: number; expires_at: Date; status: string; resume_at: Date; reason: string | null }[]>`
    SELECT current_job_id, failures_consumed, remaining_retries, expires_at, status, resume_at, reason FROM provider_deferred_jobs WHERE id = ${id}`;
  return r;
}

async function waitFor(check: () => Promise<boolean>, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "real queue worker did not settle");
    await delay(20);
  }
}

test("quota continuations preserve payload, singleton, priority, failure allowance and original expiry", async () => {
  const { boss, queue, payload, id, job } = await fixture();
  const [before] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts`;
  await runProviderAwareJob(boss, job, async () => { throw new ProviderDeferredError(new Date()); });
  const first = await row(id);
  assert.equal(first?.status, "waiting");
  assert.equal(first.remaining_retries, 3);
  assert.equal(first.failures_consumed, 0);
  assert.equal(first.expires_at.getTime(), job.keepUntil.getTime());
  assert.equal((await boss.getJobById(queue, id))?.state, "completed");
  await resumeDeferredProviderJobs(boss);
  const [next] = await boss.fetch<typeof payload>(queue, { includeMetadata: true });
  assert.ok(next);
  assert.notEqual(next.id, id);
  assert.deepEqual(next.data, payload);
  assert.equal(next.singletonKey, payload.articleId);
  assert.equal(next.priority, 19);
  assert.equal(next.retryLimit, 3);
  assert.ok(next.keepUntil <= job.keepUntil);

  // A real failure is still counted. A later quota wait cannot reset that allowance.
  await boss.fail(queue, next.id, { error: "real attempt failed" });
  const [retried] = await boss.fetch<typeof payload>(queue, { includeMetadata: true });
  assert.ok(retried);
  assert.equal(retried.retryCount, 1);
  await runProviderAwareJob(boss, retried, async () => { throw new ProviderDeferredError(new Date()); });
  const second = await row(id);
  assert.equal(second?.remaining_retries, 2);
  assert.equal(second.failures_consumed, 1);
  assert.equal(second.expires_at.getTime(), first.expires_at.getTime());
  await resumeDeferredProviderJobs(boss);
  const [last] = await boss.fetch<typeof payload>(queue, { includeMetadata: true });
  assert.ok(last);
  assert.equal(last.retryLimit, 2);
  assert.deepEqual(last.data, payload, "attemptTag never changes across deferrals");
  await runProviderAwareJob(boss, last, async () => ({ ok: true }));
  await boss.complete(queue, last.id);
  assert.equal((await row(id))?.status, "finished");
  const [after] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts`;
  assert.equal(after!.n, before!.n, "admission waits do not reserve paid attempts");
});

test("a singleton collision keeps the durable continuation waiting", async () => {
  const { boss, queue, payload, id, job } = await fixture();
  await runProviderAwareJob(boss, job, async () => { throw new ProviderDeferredError(new Date()); });
  const blocker = await boss.send(queue, payload, { singletonKey: payload.articleId });
  assert.ok(blocker);
  const result = await resumeDeferredProviderJobs(boss);
  assert.ok(result.waiting >= 1);
  assert.equal((await row(id))?.status, "waiting");
  assert.equal((await row(id))?.current_job_id, id, "a null send cannot lose the original task");
  await boss.complete(queue, blocker, null, { includeQueued: true });
});

test("waiting beyond the original deadline expires without a new queue job", async () => {
  const { boss, queue, id, job } = await fixture(2, 1);
  await runProviderAwareJob(boss, job, async () => { throw new ProviderDeferredError(new Date(Date.now() + 10_000)); });
  assert.equal((await row(id))?.status, "expired");
  await resumeDeferredProviderJobs(boss);
  assert.deepEqual(await boss.fetch(queue), []);
});

test("a resumed report retains the first job's day, week and month across calendar boundaries", async () => {
  const { boss, queue, job } = await fixture();
  // First trigger before the next issue is due; recovery may run in a different reporting period.
  const trigger = new Date("2026-09-30T23:30:00Z");
  job.createdOn = trigger;
  const expected = { daily: dueDaily(trigger), weekly: dueWeekly(trigger), monthly: dueMonthly(trigger) };
  await runProviderAwareJob(boss, job, async () => { throw new ProviderDeferredError(new Date()); });
  await resumeDeferredProviderJobs(boss);
  const [continued] = await boss.fetch(queue, { includeMetadata: true });
  assert.ok(continued);
  const actual = await runProviderAwareJob(boss, continued, async (scheduledAt) => ({
    daily: dueDaily(scheduledAt), weekly: dueWeekly(scheduledAt), monthly: dueMonthly(scheduledAt),
  }));
  assert.deepEqual(actual, expected);
  assert.notDeepEqual(expected, { daily: dueDaily(new Date("2026-10-12T04:00:00Z")), weekly: dueWeekly(new Date("2026-10-12T04:00:00Z")), monthly: dueMonthly(new Date("2026-11-01T04:00:00Z")) });
  await boss.complete(queue, continued.id);
});

test("a lost claim rolls back the deferral record rather than duplicating work", async () => {
  const { boss, queue, id, job } = await fixture();
  await boss.complete(queue, id);
  await assert.rejects(runProviderAwareJob(boss, job, async () => { throw new ProviderDeferredError(new Date()); }), /lost its queue claim/);
  assert.equal(await row(id), undefined);
});

test("scheduled admission waiting is visible without being recorded as an ordinary failure", async () => {
  const name = `quota-pause-${tag()}`;
  const pause = new ProviderDeferredError(new Date(Date.now() + 10_000));
  await assert.rejects(recordRun(name, async () => { throw pause; }), (error) => error === pause);
  const [run] = await sql<{ status: string; detail: { state: string; retryAt: string }; error: string | null }[]>`
    SELECT status, detail, error FROM job_runs WHERE job = ${name} ORDER BY id DESC LIMIT 1`;
  assert.equal(run?.status, "skipped");
  assert.equal(run.detail.state, "provider-deferred");
  assert.equal(run.detail.retryAt, pause.retryAt.toISOString());
  assert.equal(run.error, null);
});

test("real 429 stays a failure, and an expired continuation never invokes its handler", async () => {
  const { boss, id, job } = await fixture();
  const rejected = new ProviderRejectedError("rate limit", 429, true, 60);
  assert.ok(isProviderPause(rejected));
  assert.ok(isProviderPause(new ProviderDeferredError(new Date())));
  assert.equal(isProviderPause(new Error("invalid JSON")), false);
  await assert.rejects(runProviderAwareJob(boss, job, async () => { throw rejected; }), (error) => error === rejected);
  assert.equal(await row(id), undefined, "sent rejection is not converted into an unspent deferral");
  await runProviderAwareJob(boss, job, async () => { throw new ProviderDeferredError(new Date()); });
  await resumeDeferredProviderJobs(boss);
  const [continued] = await boss.fetch(job.name, { includeMetadata: true });
  assert.ok(continued);
  await sql`UPDATE provider_deferred_jobs SET expires_at = now() - interval '1 second' WHERE id = ${id}`;
  let called = false;
  await runProviderAwareJob(boss, continued as JobWithMetadata<object>, async () => { called = true; });
  assert.equal(called, false);
  assert.equal((await row(id))?.status, "expired");
  await boss.complete(job.name, continued.id);
});

test("a real pg-boss worker parks, resumes and auto-completes exactly one continuation", async () => {
  const { boss, queue, id, job } = await fixture();
  // Release the fetched claim so the real worker can pick up the original job.
  await boss.fail(queue, id);
  let invocations = 0;
  const worker = await boss.work(queue, { includeMetadata: true, pollingIntervalSeconds: 0.5 }, async ([current]) => {
    assert.ok(current);
    return runProviderAwareJob(boss, current, async () => {
      invocations++;
      if (invocations === 1) throw new ProviderDeferredError(new Date());
      return { ok: true };
    });
  });
  try {
    await waitFor(async () => (await row(id))?.status === "waiting");
    assert.equal((await row(id))?.remaining_retries, job.retryLimit - 1);
    assert.equal((await boss.getJobById(queue, id))?.state, "completed");
    await resumeDeferredProviderJobs(boss);
    await waitFor(async () => (await row(id))?.status === "finished");
    const current = (await row(id))!;
    await waitFor(async () => (await boss.getJobById(queue, current.current_job_id))?.state === "completed");
    assert.equal(invocations, 2);
    assert.deepEqual((await boss.getJobById(queue, current.current_job_id))?.output, { ok: true });
  } finally { await boss.offWork(queue, { id: worker, wait: true }); }
});

test("a fresh worker process recovers durable waits left by an exited worker process", async () => {
  const { boss, queue, id } = await fixture();
  await boss.fail(queue, id);
  const program = `
    import './tests/setup.ts';
    import { getBoss, stopBoss } from '@aihot/backend/jobs/queue';
    import { closeDb } from '@aihot/backend/db';
    import { ProviderDeferredError, runProviderAwareJob } from '@aihot/backend/jobs/provider-deferred';
    const boss = await getBoss();
    const [job] = await boss.fetch(${JSON.stringify(queue)}, { includeMetadata: true });
    if (!job) throw new Error('restart fixture missing');
    await runProviderAwareJob(boss, job, async () => { throw new ProviderDeferredError(new Date()); });
    await stopBoss(); await closeDb();
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 20_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal((await row(id))?.status, "waiting");
  const restarted = new PgBoss({ connectionString: config.databaseUrl, schema: "pgboss", application_name: "aihot-deferred-restart-test" });
  restarted.on("error", () => {});
  await restarted.start();
  let calls = 0;
  try {
    const worker = await restarted.work(queue, { includeMetadata: true, pollingIntervalSeconds: 0.5 }, async ([job]) => {
      assert.ok(job);
      return runProviderAwareJob(restarted, job, async () => { calls++; return { restarted: true }; });
    });
    await resumeDeferredProviderJobs(restarted);
    await waitFor(async () => (await row(id))?.status === "finished");
    const current = (await row(id))!;
    await waitFor(async () => (await restarted.getJobById(queue, current.current_job_id))?.state === "completed");
    assert.equal(calls, 1);
    await restarted.offWork(queue, { id: worker, wait: true });
  } finally { await restarted.stop({ graceful: true, timeout: 5_000 }); }
});

test("two independent dispatchers cannot send the same durable wait twice", async () => {
  const { boss, queue, id, job } = await fixture();
  await runProviderAwareJob(boss, job, async () => { throw new ProviderDeferredError(new Date()); });
  const other = new PgBoss({ connectionString: config.databaseUrl, schema: "pgboss", application_name: "aihot-deferred-race-test" });
  other.on("error", () => {});
  await other.start();
  try {
    await Promise.all([resumeDeferredProviderJobs(boss), resumeDeferredProviderJobs(other)]);
    assert.equal((await row(id))?.status, "dispatched");
    const jobs = await boss.findJobs(queue, { queued: true });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.id, (await row(id))?.current_job_id);
    const [continued] = await boss.fetch(queue, { includeMetadata: true });
    assert.ok(continued);
    await runProviderAwareJob(boss, continued, async () => ({ ok: true }));
    await boss.complete(queue, continued.id);
  } finally { await other.stop({ graceful: true, timeout: 5_000 }); }
});

test("a failed dispatch transaction leaves diagnosis and retries without losing or duplicating the task", async (t) => {
  const { boss, queue, id, job } = await fixture();
  await runProviderAwareJob(boss, job, async () => { throw new ProviderDeferredError(new Date()); });
  const send = boss.send.bind(boss);
  let inserted: string | null = null;
  const failure = t.mock.method(boss, "send", async (...args: Parameters<typeof boss.send>) => {
    inserted = await send(...args);
    throw new Error("injected failure after queue insert before transaction commit");
  });
  await resumeDeferredProviderJobs(boss);
  failure.mock.restore();
  assert.ok(inserted);
  assert.equal(await boss.getJobById(queue, inserted), null, "queue insert rolled back with pointer update");
  const waiting = (await row(id))!;
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.current_job_id, id);
  assert.match(waiting.reason!, /dispatch failed/);
  assert.ok(waiting.resume_at > new Date());
  // PostgreSQL timestamps have finer precision than the dispatcher's JavaScript Date. Make the
  // recovery unambiguously due rather than depending on a sub-millisecond clock boundary.
  await sql`UPDATE provider_deferred_jobs SET resume_at = now() - interval '1 second' WHERE id = ${id}`;
  await resumeDeferredProviderJobs(boss);
  assert.equal((await row(id))?.status, "dispatched");
  const [continued] = await boss.fetch(queue, { includeMetadata: true });
  assert.ok(continued);
  await runProviderAwareJob(boss, continued, async () => ({ ok: true }));
  await boss.complete(queue, continued.id);
});

test("continuations retain grouping, heartbeat, dead-letter and active-expiry options", async () => {
  const boss = await getBoss();
  const queue = `deferred.metadata.${tag()}`;
  const dead = `deferred.dead.${tag()}`;
  await boss.createQueue(dead);
  await boss.createQueue(queue, { policy: "short", retryLimit: 2, retryDelay: 1, retryBackoff: true, retryDelayMax: 9, expireInSeconds: 37, heartbeatSeconds: 10, deleteAfterSeconds: 61 });
  const payload = { reportDate: "2026-09-30", attemptTag: `metadata-${tag()}`, nested: { key: [1, "a"] } };
  const id = await boss.send(queue, payload, { singletonKey: `same-${tag()}`, priority: -9, group: { id: "report-group", tier: "reports" }, deadLetter: dead, retentionSeconds: 240 });
  assert.ok(id);
  const [job] = await boss.fetch<typeof payload>(queue, { includeMetadata: true });
  assert.ok(job);
  await runProviderAwareJob(boss, job, async () => { throw new ProviderDeferredError(new Date()); });
  await resumeDeferredProviderJobs(boss);
  const [continued] = await boss.fetch<typeof payload>(queue, { includeMetadata: true });
  assert.ok(continued);
  for (const key of ["singletonKey", "priority", "groupId", "groupTier", "deadLetter", "heartbeatSeconds", "expireInSeconds", "deleteAfterSeconds", "retryDelay", "retryBackoff", "retryDelayMax", "policy"] as const) {
    assert.equal(continued[key], job[key], `preserves ${key}`);
  }
  assert.deepEqual(continued.data, payload);
  assert.ok(continued.keepUntil <= job.keepUntil);
  await runProviderAwareJob(boss, continued, async () => ({ ok: true }));
  await boss.complete(queue, continued.id);
});

test("a recreated job preserves remaining failure allowance but resets native exponential backoff phase", async () => {
  const boss = await getBoss();
  const queue = `deferred.backoff.${tag()}`;
  await boss.createQueue(queue, { policy: "short", retryLimit: 3, retryDelay: 1, retryBackoff: true, retryDelayMax: 12, expireInSeconds: 60 });
  const id = await boss.send(queue, { attemptTag: `same-${tag()}` });
  assert.ok(id);
  const [initial] = await boss.fetch(queue, { includeMetadata: true });
  assert.ok(initial);
  await boss.fail(queue, id, { sent: true });
  let retry: JobWithMetadata<object> | undefined;
  await waitFor(async () => { [retry] = await boss.fetch(queue, { includeMetadata: true }); return !!retry; });
  assert.equal(retry!.retryCount, 1);
  await runProviderAwareJob(boss, retry!, async () => { throw new ProviderDeferredError(new Date()); });
  await resumeDeferredProviderJobs(boss);
  const [continued] = await boss.fetch(queue, { includeMetadata: true });
  assert.ok(continued);
  assert.equal(continued.retryCount, 0, "public send starts a new native backoff sequence");
  assert.equal(continued.retryLimit, 2, "one real failure remains spent");
  assert.equal(continued.retryBackoff, true);
  await boss.fail(queue, continued.id, { sent: true });
  const pending = await boss.getJobById(queue, continued.id);
  assert.equal(pending?.state, "retry");
  assert.ok(pending!.startAfter.getTime() - Date.now() < 2_100, "the next delay uses initial native backoff, not the previous phase");
  await boss.cancel(queue, continued.id);
  await resumeDeferredProviderJobs(boss);
  assert.equal((await row(id))?.status, "finished");
});

test("cancelled, exhausted, completed or removed dispatched jobs reach a diagnostic terminal state", async () => {
  for (const action of ["cancel", "fail", "complete", "delete"] as const) {
    const { boss, queue, id, job } = await fixture(0);
    await runProviderAwareJob(boss, job, async () => { throw new ProviderDeferredError(new Date()); });
    await resumeDeferredProviderJobs(boss);
    const next = (await row(id))!.current_job_id;
    if (action === "cancel") await boss.cancel(queue, next);
    else if (action === "delete") await boss.deleteJob(queue, next);
    else {
      const [claim] = await boss.fetch(queue, { includeMetadata: true });
      assert.ok(claim);
      if (action === "fail") await boss.fail(queue, next, { error: "exhausted" });
      else await boss.complete(queue, next);
    }
    await resumeDeferredProviderJobs(boss);
    assert.equal((await row(id))?.status, "finished", action);
    assert.match((await row(id))!.reason!, action === "delete" ? /missing; inspect receipts/ : /queue job/);
    assert.deepEqual(await boss.fetch(queue), [], "terminal jobs are never blindly recreated");
  }
});

test("active expiry uses pg-boss supervision and closes its dispatched continuation", async () => {
  const boss = await getBoss();
  const queue = `deferred.expire.${tag()}`;
  await boss.createQueue(queue, { retryLimit: 0, expireInSeconds: 1 });
  const id = await boss.send(queue, {});
  assert.ok(id);
  const [job] = await boss.fetch(queue, { includeMetadata: true });
  assert.ok(job);
  await runProviderAwareJob(boss, job, async () => { throw new ProviderDeferredError(new Date()); });
  await resumeDeferredProviderJobs(boss);
  const [continued] = await boss.fetch(queue, { includeMetadata: true });
  assert.ok(continued);
  await delay(1_100);
  await boss.supervise(queue);
  assert.equal((await boss.getJobById(queue, continued.id))?.state, "failed");
  await resumeDeferredProviderJobs(boss);
  assert.equal((await row(id))?.status, "finished");
  assert.match((await row(id))!.reason!, /failed/);
});

test("an aborted claim never parks a new copy, and unsupported time-window singletons fail visibly", async () => {
  const { boss, queue, id, job } = await fixture();
  const signal = new AbortController();
  signal.abort(new Error("test worker stopping"));
  job.signal = signal.signal;
  await assert.rejects(runProviderAwareJob(boss, job, async () => { throw new ProviderDeferredError(new Date()); }), ProviderDeferredError);
  assert.equal(await row(id), undefined);
  assert.equal((await boss.getJobById(queue, id))?.state, "active");
  await boss.complete(queue, id);
  const bucketId = await boss.sendThrottled(queue, {}, {}, 60, `bucket-${tag()}`);
  assert.ok(bucketId);
  const [bucket] = await boss.fetch(queue, { includeMetadata: true });
  assert.ok(bucket?.singletonOn);
  await assert.rejects(runProviderAwareJob(boss, bucket, async () => { throw new ProviderDeferredError(new Date()); }), /time-window singleton/);
  assert.equal(await row(bucketId), undefined);
  await boss.complete(queue, bucketId);
});

test("a failed durable park marks the enclosing scheduled run failed, not successfully deferred", async () => {
  const { boss, queue, id, job } = await fixture();
  await boss.complete(queue, id);
  const name = `deferred-run-failure-${tag()}`;
  await assert.rejects(recordRun(name, () => runProviderAwareJob(boss, job, async () => { throw new ProviderDeferredError(new Date()); })), /lost its queue claim/);
  const [run] = await sql`SELECT status, error FROM job_runs WHERE job = ${name}`;
  assert.equal(run!.status, "failed");
  assert.match(run!.error, /lost its queue claim/);
  assert.equal(await row(id), undefined);
});

test("unknown paid requests are not resent, while the existing audited release can revive an exhausted continuation", async () => {
  const { boss, queue, id, job } = await fixture(0);
  await runProviderAwareJob(boss, job, async () => { throw new ProviderDeferredError(new Date()); });
  await resumeDeferredProviderJobs(boss);
  const [continued] = await boss.fetch(queue, { includeMetadata: true });
  assert.ok(continued);
  const request = { service: `deferred-test-${tag()}`, purpose: "deferred_unknown", subject: `deferred:${id}`, identity: id, attemptTag: `same-${id}` };
  let calls = 0;
  const call = () => paidRequest(request, async () => { calls++; throw new Error("connection lost after send"); });
  let unknown: ReceiptUnknownError | undefined;
  await assert.rejects(runProviderAwareJob(boss, continued, call), (error) => {
    assert.ok(error instanceof ReceiptUnknownError);
    unknown = error;
    return true;
  });
  const [receipt] = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE subject = ${request.subject}`;
  assert.ok(receipt);
  assert.equal(unknown!.receiptId, receipt.id);
  await boss.fail(queue, continued.id, unknown);
  assert.equal((await row(id))?.status, "finished");
  await assert.rejects(call(), ReceiptUnknownError);
  assert.equal(calls, 1);
  await retryReleasedReceiptJobs();
  assert.equal((await boss.getJobById(queue, continued.id))?.state, "failed", "no receipt.release means no queue recovery");
  await releaseReceipt(receipt.id, { billed: false, note: "isolated mock provider verified no answer" }, "deferred-test");
  assert.ok(await retryReleasedReceiptJobs() >= 1);
  assert.equal((await row(id))?.status, "dispatched");
  const [released] = await boss.fetch(queue, { includeMetadata: true });
  assert.ok(released);
  await runProviderAwareJob(boss, released, () => paidRequest(request, async () => { calls++; return { response: { ok: true } }; }));
  await boss.complete(queue, released.id);
  assert.equal(calls, 2, "only the explicit audited release permits the second paid attempt");
  assert.equal((await row(id))?.status, "finished");
});

test("manual receipt authorization does not revive a continuation beyond its original deadline", async () => {
  const { boss, queue, id, job } = await fixture(0);
  await runProviderAwareJob(boss, job, async () => { throw new ProviderDeferredError(new Date()); });
  await resumeDeferredProviderJobs(boss);
  const [continued] = await boss.fetch(queue, { includeMetadata: true });
  assert.ok(continued);
  const request = { service: `deferred-expired-${tag()}`, purpose: "deferred_unknown", identity: id };
  let unknown: ReceiptUnknownError | undefined;
  await assert.rejects(runProviderAwareJob(boss, continued, () => paidRequest(request, async () => { throw new Error("lost response"); })), (error) => {
    assert.ok(error instanceof ReceiptUnknownError);
    unknown = error;
    return true;
  });
  await boss.fail(queue, continued.id, unknown);
  await releaseReceipt(unknown!.receiptId, { billed: false, note: "mock checked; authorize a send within the original deadline" }, "test");
  await sql`UPDATE provider_deferred_jobs SET expires_at = now() - interval '1 second' WHERE id = ${id}`;
  await retryReleasedReceiptJobs();
  assert.equal((await boss.getJobById(queue, continued.id))?.state, "failed");
  assert.equal((await row(id))?.status, "finished");
});
