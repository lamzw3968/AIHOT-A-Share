import { stub } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Fastify from "fastify";
import { listenAppForFetch, listenForFetch } from "./http-fixture.ts";
import diagnostics from "./diagnostics-reporter.ts";

const url = (server: http.Server) => `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const close = (server: http.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

test("shared stubs bind Fetch-safe loopback ports without disabling the external network guard", async () => {
  const provider = await stub(() => ({ local: true }));
  try {
    assert.ok(Number(new URL(provider.url).port) >= 16384);
    assert.deepEqual(await (await fetch(provider.url)).json(), { local: true });
    await assert.rejects(fetch("http://external-stub-guard.invalid/"), (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(String(error.cause), /Invariant tests cannot connect to external services/);
      return true;
    });
  } finally { await provider.close(); }
});

test("independent HTTP stubs skip 3659/6669 and bind collisions before returning a reachable server", async () => {
  const blocker = http.createServer();
  const server = http.createServer((_req, res) => res.end("independent"));
  await listenForFetch(blocker);
  const taken = (blocker.address() as { port: number }).port;
  const candidates = [3659, 6669, taken];
  const chosen: number[] = [];
  try {
    // The last candidates use the normal helper until they bind, avoiding a close/rebind race.
    await listenForFetch(server, () => {
      const port = candidates.shift() ?? (16384 + Math.floor(Math.random() * (65536 - 16384)));
      chosen.push(port);
      return port;
    });
    assert.deepEqual(chosen.slice(0, 3), [3659, 6669, taken]);
    assert.notEqual((server.address() as { port: number }).port, taken);
    assert.ok(Number(new URL(url(server)).port) >= 16384);
    assert.equal(await (await fetch(url(server))).text(), "independent");
  } finally { await Promise.all([close(server), close(blocker)]); }
});

test("Fastify fixtures use the same safe candidate policy and preserve normal startup", async () => {
  const app = Fastify();
  app.get("/", async () => ({ fastify: true }));
  const candidates = [3659, 6669];
  try {
    const address = await listenAppForFetch(app, () => candidates.shift() ?? (16384 + Math.floor(Math.random() * (65536 - 16384))));
    assert.equal(candidates.length, 0);
    assert.ok(Number(new URL(address).port) >= 16384);
    assert.deepEqual(await (await fetch(address)).json(), { fastify: true });
  } finally { await app.close(); }
});

test("exhausted bind collisions retain the complete cause and release temporary listeners", async () => {
  const blocker = http.createServer();
  const server = http.createServer();
  const listeners = { error: server.listenerCount("error"), listening: server.listenerCount("listening") };
  await listenForFetch(blocker);
  let tries = 0;
  try {
    await assert.rejects(listenForFetch(server, () => { tries++; return (blocker.address() as { port: number }).port; }), (error) => {
      assert.ok(error instanceof Error);
      assert.equal((error.cause as NodeJS.ErrnoException).code, "EADDRINUSE");
      return true;
    });
    assert.equal(tries, 64, "only collisions are retried, with a finite bound");
    assert.equal(server.listenerCount("error"), listeners.error);
    assert.equal(server.listenerCount("listening"), listeners.listening);
  } finally { await close(blocker); }
});

test("the safe port range excludes every bad port in the installed Fetch implementation", async () => {
  const constants = await readFile(new URL("../node_modules/undici/lib/web/fetch/constants.js", import.meta.url), "utf8");
  const declaration = /const badPorts =[^\[]*\[([\s\S]*?)\]/.exec(constants);
  assert.ok(declaration, "inspect the actual installed Fetch port list instead of weakening its security checks");
  const blocked = [...declaration[1]!.matchAll(/'(\d+)'/g)].map((m) => Number(m[1]));
  assert.ok(blocked.includes(3659));
  assert.ok(blocked.includes(6669));
  assert.ok(blocked.every((port) => port < 16384));
});

test("failure diagnostics preserve exit status, stderr and complete nested causes", async () => {
  const cause = Object.assign(new Error("socket detail"), { code: "ECONNRESET" });
  const error = Object.assign(new Error("child failed", { cause: new Error("fetch failed", { cause }) }), { exitCode: 1, signal: null });
  async function* events() {
    yield { type: "test:stderr", data: { file: "test-fixture", message: "child stderr\n" } };
    yield { type: "test:fail", data: { details: { error } } };
  }
  const lines: string[] = [];
  for await (const line of diagnostics(events())) lines.push(line);
  assert.equal(lines.length, 2);
  assert.match(JSON.parse(lines[0]!).detail, /child stderr/);
  const detail = JSON.parse(lines[1]!).detail;
  for (const value of ["child failed", "fetch failed", "socket detail", "ECONNRESET", "exitCode: 1", "signal: null"]) assert.ok(detail.includes(value), value);
});
