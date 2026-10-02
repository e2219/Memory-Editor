import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { CredentialManager, createInvite, readLedger, writeLedger, revokeInvite, initializeLedger } from "../src/credentials.ts";
import { createWebServer } from "../src/web-server.ts";
import { MockGateway } from "../src/model.ts";
import { DeepSeekGateway } from "../src/deepseek.ts";

test("sponsor raw request reservations persist, serialize and obey per-invite/global limits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-budget-"));
  const factory = (_key: string, reserve?: () => Promise<void>) => ({
    analyze: async () => { await reserve?.(); return {}; }, narrate: async () => { await reserve?.(); return {}; },
  });
  let manager = new CredentialManager({ directory, ownerKey: "owner-placeholder-key", globalLimit: 3, factory });
  try {
    const first = await createInvite(directory, "first", 2);
    const second = await createInvite(directory, "second", 10);
    const login = await manager.login({ kind: "invite", code: first.code });
    assert.equal((await manager.login({ kind: "invite", code: first.code })).token, login.token);
    const gateway = await manager.gateway("session", login.binding);
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => gateway.analyze({} as never)));
    assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 2);
    assert.equal((await readLedger(directory)).used, 2);
    manager.close(); manager = new CredentialManager({ directory, ownerKey: "owner-placeholder-key", globalLimit: 3, factory });
    await assert.rejects(manager.gateway("session", login.binding), /额度/);
    const next = await manager.login({ kind: "invite", code: second.code });
    await (await manager.gateway("session2", next.binding)).analyze({} as never);
    await assert.rejects(manager.gateway("session2", next.binding), /额度/);
    assert.equal((await readLedger(directory)).used, 3);
    await revokeInvite(directory, first.id);
    await assert.rejects(manager.login({ kind: "invite", code: first.code }), /撤销/);
    const persisted = await readFile(join(directory, "invites.json"), "utf8");
    assert.ok(!persisted.includes(first.code)); assert.ok(!persisted.includes("owner-placeholder-key"));
  } finally { manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test("DeepSeek retries reserve each HTTP attempt and budget refusal never contacts upstream", async () => {
  const oldFetch = globalThis.fetch;
  let calls = 0, reserves = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response("provider-private-body", { status: 500 }); };
    const gateway = new DeepSeekGateway({ apiKey: "not-a-real-api-key", beforeRequest: async () => {
      reserves++; if (reserves > 1) throw new Error("budget-exhausted");
    } });
    await assert.rejects(gateway.probe(), /budget-exhausted/);
    assert.equal(calls, 1); assert.equal(reserves, 2);
  } finally { globalThis.fetch = oldFetch; }
});

test("BYOK cannot fall back to owner key, and expired/revoked invitations fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-keys-"));
  const usedKeys: string[] = [];
  const manager = new CredentialManager({ directory, ownerKey: "owner-placeholder-key", factory: (key) => { usedKeys.push(key); return new MockGateway(); } });
  try {
    await initializeLedger(directory);
    const login = await manager.login({ kind: "byok", apiKey: "player-placeholder-key" });
    manager.attach("player", login.gateway);
    assert.equal(manager.ready("player", login.binding), true);
    await manager.gateway("player", login.binding);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 31 * 60_000;
      assert.equal(manager.ready("player", login.binding), false);
      await assert.rejects(manager.gateway("player", login.binding), /重新输入/);
    } finally { Date.now = realNow; }
    manager.forget("player");
    await assert.rejects(manager.gateway("player", login.binding), /重新输入/);
    await assert.rejects(manager.gateway("legacy"), /旧测试口令/);
    assert.deepEqual(usedKeys, ["player-placeholder-key"]);
    const invite = await createInvite(directory, "revocation");
    const sponsored = await manager.login({ kind: "invite", code: invite.code });
    await revokeInvite(directory, invite.id);
    await assert.rejects(manager.gateway("sponsor", sponsored.binding), /撤销/);
    const expired = await createInvite(directory, "expired");
    const ledger = await readLedger(directory);
    ledger.invites.find((item) => item.id === expired.id)!.expiresAt = Date.now() - 1000;
    await writeLedger(directory, ledger);
    await assert.rejects(manager.login({ kind: "invite", code: expired.code }), /过期/);
    ledger.used = 999;
    await writeLedger(directory, ledger);
    await assert.rejects(readLedger(directory), /校验失败/);
    const disabled = new CredentialManager({ directory, ownerKey: "owner-placeholder-key", globalLimit: 0 });
    try { await assert.rejects(disabled.login({ kind: "invite", code: invite.code }), /未开启/); }
    finally { disabled.close(); }
  } finally { manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test("web auth: separate payer, no persisted keys, same invite same game, restart recovery and no proxy fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-auth-web-"));
  const calls: string[] = [];
  const factory = (key: string, reserve?: () => Promise<void>) => {
    const mock = new MockGateway();
    return { analyze: async (request: Parameters<MockGateway["analyze"]>[0]) => { await reserve?.(); calls.push(key); return mock.analyze(request); },
      narrate: async (request: Parameters<MockGateway["narrate"]>[0]) => { await reserve?.(); calls.push(key); return mock.narrate(request); } };
  };
  await initializeLedger(directory);
  const invite = await createInvite(directory, "tester", 4);
  let credentials = new CredentialManager({ directory, ownerKey: "owner-placeholder-key", globalLimit: 10, factory });
  const options = () => ({ credentials, dataDir: directory, publicDir: fileURLToPath(new URL("../web/", import.meta.url)), minTurnIntervalMs: 0 });
  let server = await createWebServer(options());
  const listen = async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  };
  const close = async () => { await new Promise<void>((resolve) => server.close(() => resolve())); credentials.close(); };
  let base = await listen();
  const api = async (path: string, body?: unknown, cookie = "") => {
    const response = await fetch(`${base}/api/${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };
  const turn = { revision: 0, requestId: "credential-turn-001", text: "那双手有什么特征？", operation: "inquire" };
  try {
    assert.equal((await api("login", { code: "old-shared-code" })).status, 403);
    assert.equal((await api("login", { kind: "byok", apiKey: "player-placeholder-key", apiUrl: "http://example.com" })).status, 400);
    const player = await api("login", { kind: "byok", apiKey: "player-placeholder-key" });
    assert.equal(player.status, 200); assert.equal(player.data.credentialKind, "byok");
    assert.equal((await api("turn", { ...turn, model: "other-model" }, player.cookie)).status, 400);
    assert.equal((await api("chat/completions", { messages: [] }, player.cookie)).status, 404);
    assert.equal(calls.length, 0);
    const played = await api("turn", turn, player.cookie);
    assert.equal(played.status, 200); assert.equal(played.data.turn, 1);
    assert.ok(calls.every((key) => key === "player-placeholder-key"));
    const sponsored = await api("login", { kind: "invite", code: invite.code });
    const firstTurn = await api("turn", turn, sponsored.cookie);
    assert.equal(firstTurn.status, 200); assert.equal((await readLedger(directory)).used, 2);
    const otherBrowser = await api("login", { kind: "invite", code: invite.code });
    assert.equal(otherBrowser.cookie, sponsored.cookie); assert.equal(otherBrowser.data.turn, 1);
    assert.equal((await api("turn", turn, sponsored.cookie)).status, 200);
    assert.equal((await readLedger(directory)).used, 2, "idempotent retry cannot spend twice");
    assert.equal((await api("credentials", { apiKey: "different-player-key" }, sponsored.cookie)).status, 403);
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".json")) continue;
      const text = await readFile(join(directory, file), "utf8");
      assert.ok(!text.includes("player-placeholder-key")); assert.ok(!text.includes("owner-placeholder-key")); assert.ok(!text.includes(invite.code));
    }
    await close(); credentials = new CredentialManager({ directory, ownerKey: "owner-placeholder-key", globalLimit: 10, factory });
    server = await createWebServer(options()); base = await listen();
    assert.equal((await api("session", undefined, player.cookie)).data.credentialRequired, true);
    const attemptsBefore = calls.length;
    assert.equal((await api("turn", { ...turn, revision: 1, requestId: "after-restart-001" }, player.cookie)).status, 428);
    assert.equal(calls.length, attemptsBefore);
    assert.equal((await api("credentials", { apiKey: "replacement-player-key" }, player.cookie)).status, 200);
    assert.equal((await api("session", undefined, player.cookie)).data.turn, 1);
    await api("logout", {}, player.cookie);
    assert.equal((await api("turn", { ...turn, revision: 1, requestId: "after-logout-001" }, player.cookie)).status, 428);
    await revokeInvite(directory, invite.id);
    assert.equal((await api("session", undefined, sponsored.cookie)).status, 403);
    assert.equal((await api("turn", { ...turn, revision: 1, requestId: "after-revoke-001" }, sponsored.cookie)).status, 403);
  } finally { await close(); await rm(directory, { recursive: true, force: true }); }
});
