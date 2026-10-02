import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebServer } from "../src/web-server.ts";
import { MockGateway } from "../src/model.ts";

test("web: default capacity allows 30 sessions, rejects the 31st and preserves existing login", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "memory-web-capacity-"));
  const server = await createWebServer({ gateway: new MockGateway(), accessCode: "capacity-test-code", dataDir,
    publicDir: fileURLToPath(new URL("../web/", import.meta.url)) });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/api/login`;
    const login = (cookie = "") => fetch(url, { method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ code: "capacity-test-code" }) });
    let firstCookie = "";
    for (let count = 1; count <= 30; count++) {
      const response = await login();
      assert.equal(response.status, 200, `session ${count}`);
      if (count === 1) firstCookie = response.headers.get("set-cookie")!.split(";")[0];
      await response.json();
    }
    const overflow = await login();
    assert.equal(overflow.status, 429); await overflow.json();
    const existing = await login(firstCookie);
    assert.equal(existing.status, 200);
    assert.equal(existing.headers.get("set-cookie")!.split(";")[0], firstCookie);
    await existing.json();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("web: isolated, persistent sessions; explicit disclosure and idempotent turns", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "memory-web-test-"));
  const gateway = new MockGateway();
  let analyzeCalls = 0;
  const analyze = gateway.analyze.bind(gateway);
  gateway.analyze = async (request) => { analyzeCalls++; return analyze(request); };
  const options = { gateway, accessCode: "test-password", dataDir,
    publicDir: fileURLToPath(new URL("../web/", import.meta.url)), minTurnIntervalMs: 0, maxSessions: 2 };
  let server = await createWebServer(options);
  const listen = async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  };
  const close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  let base = await listen();
  const call = async (path: string, body?: unknown, cookie = "", headers = {}) => {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "", data: await response.json() };
  };
  try {
    assert.equal((await call("/api/session")).status, 401);
    assert.equal((await call("/api/login", { code: "wrong" })).status, 401);
    const first = await call("/api/login", { code: options.accessCode });
    const second = await call("/api/login", { code: options.accessCode });
    assert.equal(first.status, 200); assert.notEqual(first.cookie, second.cookie);
    assert.equal((await call("/api/login", { code: options.accessCode })).status, 429);
    assert.equal(first.data.turn, 0); assert.equal(first.data.clues.length, 1);
    for (const field of ["memories", "claims", "hidden", "sources", "progress", "stage"]) assert.equal(first.data[field], undefined);
    assert.equal(first.data.mailbox[0].body, undefined);
    assert.equal((await call("/api/reveal", {}, first.cookie)).status, 403);
    assert.equal((await call("/src/revelation.ts")).status, 404);
    assert.equal((await call("/api/note", {}, first.cookie, { Origin: "https://evil.example" })).status, 403);
    const payload = { requestId: "turn-request-001", revision: 0, operation: "inquire", text: "削橙子的人，手有什么特征？" };
    const turn = await call("/api/turn", payload, first.cookie);
    assert.equal(turn.status, 200, JSON.stringify(turn.data));
    assert.equal(turn.data.turn, 1); assert.equal(turn.data.revision, 1);
    assert.equal((await call("/api/turn", payload, first.cookie)).data.turn, 1);
    assert.equal(analyzeCalls, 1);
    assert.equal((await call("/api/session", undefined, second.cookie)).data.turn, 0);
    assert.equal((await call("/api/note", { revision: 0, requestId: "stale-note-001", text: "一个疑点" }, first.cookie)).status, 409);
    const mismatch = await call("/api/turn", { ...payload, requestId: "turn-request-002", revision: 1, text: "想不起来没关系" }, first.cookie);
    assert.equal(mismatch.status, 422); assert.equal(mismatch.data.detectedOperation, "empathize");
    const retry = await call("/api/turn", { ...payload, requestId: "turn-request-002", revision: 1, text: "想不起来没关系", operation: "empathize" }, first.cookie);
    assert.equal(retry.status, 200); assert.equal(analyzeCalls, 2);
    gateway.analyze = async () => { throw new Error("secret-provider-body-and-key"); };
    const failed = await call("/api/turn", { ...payload, revision: 2, requestId: "failed-turn-003" }, first.cookie);
    assert.equal(failed.status, 502); assert.ok(!JSON.stringify(failed.data).includes("secret-provider"));
    assert.equal((await call("/api/session", undefined, first.cookie)).data.turn, 2);
    const note = await call("/api/note", { revision: 2, requestId: "private-note-001", text: "暂时不指定那个人是谁" }, first.cookie);
    assert.equal(note.status, 200); assert.equal(note.data.notes.length, 1); assert.equal(note.data.notes[0].insight, undefined);
    assert.equal((await call("/api/session", undefined, second.cookie)).data.notes.length, 0);
    const mail = await call("/api/mail", { revision: 3, requestId: "mail-read-001", mailId: note.data.mailbox[0].id, status: "read" }, first.cookie);
    assert.equal(mail.status, 200); assert.ok(mail.data.mailbox[0].body);
    const ending = await call("/api/conclude", { revision: 4, requestId: "conclude-001", disposition: "defer", confirm: true, text: "现有资料不足，我选择保留疑点。" }, first.cookie);
    assert.equal(ending.status, 200, JSON.stringify(ending.data)); assert.ok(ending.data.ending);
    assert.equal((await call("/api/reveal", {}, first.cookie)).status, 200);
    assert.equal((await call("/api/turn", { ...payload, revision: 5, requestId: "ended-turn-004" }, first.cookie)).status, 409);
    await close(); server = await createWebServer(options); base = await listen();
    const restored = await call("/api/session", undefined, first.cookie);
    assert.equal(restored.data.turn, 2); assert.equal(restored.data.notes.length, 1); assert.ok(restored.data.ending);
  } finally { await close(); await rm(dataDir, { recursive: true, force: true }); }
});
