// Real PostgreSQL transactions and the complete processing pipeline; only paid HTTP is a loopback stub.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test, type TestContext } from "node:test";
import { closeDb, sql, type Tx } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { processArticle } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const SOURCE = `commit-recovery-${T}`;
const calls: string[] = [];
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body);
  const system = String(body.messages[0]?.content ?? "");
  const step = system.includes("宽召回的财经相关性预筛") ? "prefilter"
    : system.includes("事件注意力评分器") ? "score"
    : system.includes("资料结构化助手") ? "structure" : "understand";
  calls.push(step);
  const content = step === "prefilter" ? { label: "PASS", reason: "local fixture" }
    : step === "score" ? { attentionScore: 80 }
    : step === "structure" ? { category: "company", tags: [], subjects: [], fact: null }
    : { itemType: "company_event", authorRole: "principal", tags: ["公司动态"], editorialJudgment: "订单金额明确",
      titleZh: `虚构甲公司签署订单 ${T}`, summaryZh: "虚构甲公司签署2亿元订单，合同待履行。" };
  return { id: `local-${T}-${calls.length}`, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 } };
});
for (const name of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL"]) process.env[name] = `${provider.url}/v1`;
for (const name of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY"]) process.env[name] = "test-commit-recovery";
Object.assign(process.env, { PREFILTER_MODEL: "qwen3.7-flash", SCORE_MODEL: "glm-5.3-flash-selection",
  STRUCTURE_MODEL: "qwen3.8-flash", UNDERSTAND_MODEL: "glm-5.3-flash" });
let budgets: Array<{ service: string; per_minute: number; per_hour: number; per_day: number }> = [];
before(async () => {
  budgets = await sql`SELECT service,per_minute,per_hour,per_day FROM budgets WHERE service IN ('dashscope','zhipu')`;
  await sql`UPDATE budgets SET per_minute=10000,per_hour=10000,per_day=100000 WHERE service IN ('dashscope','zhipu')`;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES (${SOURCE},'Commit recovery mock','rss','T1','editorial','2100-01-01')`;
});
after(async () => {
  await stopBoss();
  await provider.close();
  // These live processing fixtures publish and enqueue follow-up work. Remove only this file's
  // rows so later shared-database queue/sync tests cannot consume them or inherit a release gate.
  try {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM pgboss.job WHERE data->>'articleId' IN (SELECT id FROM articles WHERE source_id=${SOURCE})`;
      await tx`DELETE FROM selected_ledger WHERE article_id IN (SELECT id FROM articles WHERE source_id=${SOURCE})`;
      await tx`DELETE FROM selected_state WHERE article_id IN (SELECT id FROM articles WHERE source_id=${SOURCE})`;
      await tx`DELETE FROM receipts WHERE subject IN (SELECT 'article:' || id || '@1' FROM articles WHERE source_id=${SOURCE})`;
      await tx`DELETE FROM articles WHERE source_id=${SOURCE}`;
      await tx`DELETE FROM sources WHERE id=${SOURCE}`;
    });
  } finally {
    for (const row of budgets) await sql`UPDATE budgets SET per_minute=${row.per_minute},per_hour=${row.per_hour},per_day=${row.per_day} WHERE service=${row.service}`;
    await closeDb();
  }
});

async function article(name: string) {
  return (await upsertMaterial({ sourceId: SOURCE, url: `https://example.org/${T}/${name}`, title: `虚构甲公司签署订单 ${T} ${name}`,
    bodyText: `虚构甲公司签署2亿元订单 ${T} ${name}。` + "本材料为本地测试，订单金额和合同履行阶段已经明确。".repeat(24),
    bodyStatus: "ok", via: "fetch", publishedAt: new Date() })).articleId;
}

function fault(t: TestContext, articleId: string, purpose: string, mode: "ack" | "rollback" | "unreadable") {
  const begin = sql.begin.bind(sql);
  let injected = false;
  let confirmationFailed = false;
  let receiptId = 0;
  const subject = `article:${articleId}@1`;
  const hook = t.mock.method(sql, "begin", (async (callback: (tx: Tx) => Promise<unknown>) => {
    if (mode === "rollback" && !injected) {
      return begin(async (tx) => {
        const result = await callback(tx);
        const [row] = await tx<{ id: number }[]>`SELECT id FROM receipts WHERE subject=${subject} AND purpose=${purpose} AND status='received'`;
        if (row && !injected) {
          receiptId = row.id;
          injected = true;
          await tx.unsafe("SELECT 1 / 0"); // Real database failure before COMMIT, not a mocked response.
        }
        return result;
      });
    }
    const confirm = mode === "unreadable" && injected && !confirmationFailed;
    const result = await begin(async (tx) => {
      const value = await callback(tx);
      if (confirm) {
        confirmationFailed = true;
        await tx.unsafe("SELECT 1 / 0"); // The confirmation itself cannot commit successfully.
      }
      return value;
    });
    if (!injected) {
      const [row] = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE subject=${subject} AND purpose=${purpose} AND status='received'`;
      if (row && !injected) {
        receiptId = row.id;
        injected = true;
        throw new Error("lost acknowledgement after a real PostgreSQL COMMIT");
      }
    }
    return result;
  }) as typeof sql.begin);
  return { hook, injected: () => injected, confirmationFailed: () => confirmationFailed, receiptId: () => receiptId };
}

async function completed(articleId: string) {
  const subject = `article:${articleId}@1`;
  const [state] = await sql`SELECT processing_state,processing_error,processing_attempts,processing_retry_at FROM articles WHERE id=${articleId}`;
  assert.deepEqual(state, { processing_state: "analyzed", processing_error: null, processing_attempts: 0, processing_retry_at: null });
  const analyses = await sql`SELECT relevance,selected,receipt_ids FROM analyses WHERE article_id=${articleId}`;
  assert.equal(analyses.length, 1);
  assert.equal(analyses[0]!.relevance, "pass");
  assert.equal(analyses[0]!.selected, true);
  assert.equal(analyses[0]!.receipt_ids.length, 5);
  assert.equal((await sql`SELECT 1 FROM publications WHERE article_id=${articleId}`).length, 1);
  const rows = await sql`SELECT r.id,r.status,r.attempts,a.status AS attempt_status,a.attempt,a.finished_at IS NOT NULL AS finished
    FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id WHERE r.subject=${subject}`;
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.status === "completed" && r.attempts === 1 && r.attempt === 1 && r.attempt_status === "received" && r.finished));
  assert.deepEqual(rows.map((r) => r.id).sort(), [...analyses[0]!.receipt_ids].sort());
}

for (const purpose of ["prefilter_article", "score_article", "structure_article", "understand_article"]) {
  test(`processArticle completes all business writes after a lost ${purpose} COMMIT acknowledgement`, async (t) => {
    const id = await article(purpose);
    const hits = calls.length;
    const injected = fault(t, id, purpose, "ack");
    try {
      assert.deepEqual(await processArticle(id), { state: "pass" });
    } finally { injected.hook.mock.restore(); }
    assert.equal(injected.injected(), true, "the real received transaction must commit before injecting the fault");
    assert.deepEqual(calls.slice(hits).sort(), ["prefilter", "score", "score", "structure", "understand"]);
    await completed(id);
  });
}

test("processArticle stops after a real response rollback without retrying the paid request", async (t) => {
  const id = await article("rollback");
  const hits = calls.length;
  const injected = fault(t, id, "prefilter_article", "rollback");
  try { assert.deepEqual(await processArticle(id), { state: "unknown-receipt" }); }
  finally { injected.hook.mock.restore(); }
  assert.equal(injected.injected(), true);
  assert.deepEqual(await processArticle(id), { state: "unknown-receipt" });
  assert.deepEqual(calls.slice(hits), ["prefilter"]);
  const [row] = await sql`SELECT r.status,r.response,a.status AS attempt_status FROM receipts r
    JOIN receipt_attempts a ON a.receipt_id=r.id WHERE r.id=${injected.receiptId()}`;
  assert.deepEqual(row, { status: "unknown", response: null, attempt_status: "unknown" });
  assert.equal((await sql`SELECT 1 FROM receipt_attempts WHERE receipt_id=${injected.receiptId()}`).length, 1);
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${id}`)[0]!.processing_state, "failed");
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id=${id}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM publications WHERE article_id=${id}`).length, 0);
});

test("processArticle blocks an unconfirmed commit and later finishes from its durable answer without resending", async (t) => {
  const id = await article("unreadable");
  const hits = calls.length;
  const injected = fault(t, id, "prefilter_article", "unreadable");
  try { assert.deepEqual(await processArticle(id), { state: "unknown-receipt" }); }
  finally { injected.hook.mock.restore(); }
  assert.equal(injected.confirmationFailed(), true);
  assert.deepEqual(calls.slice(hits), ["prefilter"]);
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${id}`)[0]!.processing_state, "failed");
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id=${id}`).length, 0);
  assert.deepEqual(await processArticle(id), { state: "pass" });
  assert.deepEqual(calls.slice(hits).sort(), ["prefilter", "score", "score", "structure", "understand"]);
  await completed(id);
});
