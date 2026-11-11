// Admin identity decisions are security-sensitive: exercise the actual HTTP guard and session.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { endSession, passwordLogin, SESSION_COOKIE } from "@aihot/backend/admin/auth";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { logicalKeyFor } from "@aihot/backend/providers/receipts";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const password = `fixture-admin-password-${T}`;
const saved = { devAdmin: config.devAdmin, environmentName: config.environmentName,
  adminPassword: config.adminPassword, modelCallsEnabled: config.modelCallsEnabled };

test("identity conflict API requires an active admin session and CSRF, and audits revocation with the actual actor", async (t) => {
  config.devAdmin = null;
  config.environmentName = "test";
  config.adminPassword = password;
  config.modelCallsEnabled = false;
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("admin identity review must not contact a provider"); });
  const model = "Ling-3.1-flash";
  const wireBody = JSON.stringify({ model, messages: [{ role: "user", content: `old ${T}` }], temperature: 0.3, max_tokens: 100 });
  const oldCanonicalHash = sha256(stableJson(JSON.parse(wireBody)));
  const wireHash = sha256(wireBody);
  assert.notEqual(wireHash, oldCanonicalHash);
  const oldIdentity = { model, promptVersion: "test", system: sha256("system"), user: sha256(`old ${T}`),
    temperature: 0.3, maxTokens: 100, extra: null, bodyHash: oldCanonicalHash };
  const newBody = { model, messages: [{ role: "user", content: `different ${T}` }], temperature: 0.3, max_tokens: 100 };
  const requestIdentity = { version: 2, model, promptVersion: "test", system: sha256("system"), user: sha256(`different ${T}`),
    temperature: 0.3, maxTokens: 100, extraHash: sha256(stableJson(null)), bodyHash: sha256(stableJson(newBody)) };
  const oldKey = logicalKeyFor({ service: "llm", purpose: "prefilter_article", model, identity: oldIdentity });
  const requestKey = logicalKeyFor({ service: "llm", purpose: "prefilter_article", model, identity: requestIdentity });
  const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts
    (logical_key,service,model,purpose,subject,status,request,attempts)
    VALUES (${oldKey},'llm','Ling-3.1-flash','prefilter_article',${`article:${T}@1`},'unknown',
      ${sql.json({ bodyHash: wireHash })},1) RETURNING id`;
  const [attempt] = await sql<{ id: number }[]>`INSERT INTO receipt_attempts
    (receipt_id,attempt,service,model,status) VALUES (${receipt!.id},1,'llm','Ling-3.1-flash','unknown') RETURNING id`;
  const [conflict] = await sql<{ id: number }[]>`INSERT INTO receipt_identity_conflicts
    (receipt_id,receipt_key,receipt_wire_hash,receipt_attempts,request_key,request_identity,request_tag)
    VALUES (${receipt!.id},${oldKey},${wireHash},1,${requestKey},${sql.json(requestIdentity)},'0') RETURNING id`;
  const subject = `receipt-identity:${conflict!.id}`;
  const app = await buildApp();
  const base = "/api/admin/receipt-identity-conflicts";
  const authorize = `${base}/${conflict!.id}/authorize`;
  const revoke = `${base}/${conflict!.id}/revoke`;
  const payload = { oldIdentity, wireBody, reason: "test review evidence", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  const revokePayload = { reason: "fixture review revoked" };
  let cookie: string | undefined;
  let createdUser = false;
  let userId: number | undefined;
  let loginAuditId: number | undefined;
  try {
    assert.equal((await app.inject({ method: "GET", url: base })).statusCode, 401);
    for (const [url, body] of [[authorize, payload], [revoke, revokePayload]] as const) {
      assert.equal((await app.inject({ method: "POST", url, payload: body, headers: { "x-csrf-token": "dev" } })).statusCode, 401);
    }
    const [existing] = await sql<{ id: number }[]>`SELECT id FROM admin_users WHERE email='admin@local'`;
    const login = await passwordLogin(password, "/admin", "identity-admin-test");
    userId = Number(login.userId);
    createdUser = !existing;
    cookie = `${SESSION_COOKIE}=${login.token}`;
    const [loginAudit] = await sql<{ id: number }[]>`SELECT id FROM audit_log WHERE action='auth.login' AND actor=${`admin:${userId}`} ORDER BY id DESC LIMIT 1`;
    loginAuditId = loginAudit?.id;
    const me = await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie } });
    assert.equal(me.statusCode, 200);
    const csrf = me.json<{ csrf: string }>().csrf;
    const list = await app.inject({ method: "GET", url: base, headers: { cookie } });
    assert.equal(list.statusCode, 200);
    assert.match(list.headers["cache-control"]!, /no-store/);
    const listed = list.json<{ conflicts: Array<{ id: number }> }>().conflicts;
    assert.ok(listed.some((row) => Number(row.id) === Number(conflict!.id)));
    for (const [url, body] of [[authorize, payload], [revoke, revokePayload]] as const) {
      for (const token of [undefined, "wrong-csrf"]) {
        const response: { statusCode: number } = await app.inject({ method: "POST", url, payload: body,
          headers: { cookie, ...(token ? { "x-csrf-token": token } : {}) } });
        assert.equal(response.statusCode, 403);
      }
    }
    for (const invalid of [
      { oldIdentity, reason: payload.reason, expiresAt: payload.expiresAt },
      { ...payload, wireBody: 123 },
      { ...payload, wireBody: "{bad json" },
    ]) {
      const invalidResponse: { statusCode: number } = await app.inject({ method: "POST", url: authorize,
        payload: invalid, headers: { cookie, "x-csrf-token": csrf } });
      assert.equal(invalidResponse.statusCode, 400, "invalid evidence is rejected after authenticating the session");
    }
    assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject=${subject}`).length, 0);
    for (const invalid of [ { ...payload, wireBody: `${wireBody} ` },
      { ...payload, oldIdentity: { ...oldIdentity, user: sha256("forged") } } ]) {
      const invalidResponse: { statusCode: number } = await app.inject({ method: "POST", url: authorize,
        payload: invalid, headers: { cookie, "x-csrf-token": csrf } });
      assert.equal(invalidResponse.statusCode, 409, "different evidence cannot authorize the identity conflict");
    }
    assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject=${subject}`).length, 0);
    assert.equal((await sql`SELECT state FROM receipt_identity_conflicts WHERE id=${conflict!.id}`)[0]!.state, "waiting");
    const granted = await app.inject({ method: "POST", url: authorize, payload, headers: { cookie, "x-csrf-token": csrf } });
    assert.equal(granted.statusCode, 200, granted.body);
    assert.deepEqual(granted.json(), { id: Number(conflict!.id), state: "authorized", expiresAt: payload.expiresAt });
    const [grantAudit] = await sql`SELECT actor,action,subject,reason,after FROM audit_log
      WHERE subject=${subject} AND action='receipt.identity.authorize'`;
    assert.equal(grantAudit!.actor, `admin:${userId}`);
    assert.equal(grantAudit!.reason, payload.reason);
    assert.equal(grantAudit!.after.receiptId, Number(receipt!.id));
    assert.equal(grantAudit!.after.receiptKey, oldKey);
    assert.equal(grantAudit!.after.requestKey, requestKey);
    assert.equal((await app.inject({ method: "POST", url: authorize, payload, headers: { cookie, "x-csrf-token": csrf } })).statusCode, 409);
    const response = await app.inject({ method: "POST", url: revoke, payload: revokePayload,
      headers: { cookie, "x-csrf-token": csrf } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<{ state: string }>().state, "revoked");
    const [audit] = await sql`SELECT actor,action,subject,reason FROM audit_log WHERE subject=${subject} AND action='receipt.identity.revoke'`;
    assert.deepEqual(audit, { actor: `admin:${userId}`, action: "receipt.identity.revoke", subject, reason: revokePayload.reason });
    const [preserved] = await sql`SELECT r.status,r.logical_key,r.attempts,a.status AS attempt_status
      FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id WHERE r.id=${receipt!.id} AND a.id=${attempt!.id}`;
    assert.deepEqual(preserved, { status: "unknown", logical_key: oldKey, attempts: 1, attempt_status: "unknown" });
    assert.equal(fetches, 0);
    await endSession(cookie);
    assert.equal((await app.inject({ method: "GET", url: base, headers: { cookie } })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: authorize, payload, headers: { cookie, "x-csrf-token": csrf } })).statusCode, 401);
  } finally {
    if (cookie) await endSession(cookie);
    await app.close();
    await sql`DELETE FROM audit_log WHERE subject=${subject}`;
    if (loginAuditId) await sql`DELETE FROM audit_log WHERE id=${loginAuditId}`;
    await sql`DELETE FROM receipts WHERE id=${receipt!.id}`;
    if (createdUser && userId) await sql`DELETE FROM admin_users WHERE id=${userId}`;
    Object.assign(config, saved);
    await closeDb();
  }
});
