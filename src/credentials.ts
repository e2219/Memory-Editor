import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { DeepSeekGateway } from "./deepseek.ts";
import type { RawModelGateway } from "./model.ts";

export type CredentialBinding = { kind: "byok" } | { kind: "invite"; inviteId: string };
type Invite = { id: string; label: string; codeHash: string; expiresAt: number; revoked: boolean; maxRequests: number; used: number };
type Ledger = { version: 1; secret: string; used: number; invites: Invite[] };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export class CredentialError extends Error {
  status: number;
  constructor(message: string, status = 403) { super(message); this.status = status; }
}

// All writers share an exclusive filesystem lock; a crash leaves it fail-closed.
async function withLedgerLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const lock = join(directory, "ledger.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CredentialError("额度账本暂忙，请稍后重试。", 503);
    throw error;
  }
  try { return await action(); } finally { await rmdir(lock); }
}
export async function readLedger(directory: string): Promise<Ledger> {
  const ledger = JSON.parse(await readFile(join(directory, "invites.json"), "utf8")) as Ledger;
  if (ledger.version !== 1 || !/^[a-f0-9]{64}$/.test(ledger.secret ?? "") ||
    !Number.isSafeInteger(ledger.used) || ledger.used < 0 || !Array.isArray(ledger.invites) ||
    ledger.invites.some((invite) => !invite || !/^[a-f0-9]{16}$/.test(invite.id) ||
      !/^[a-f0-9]{64}$/.test(invite.codeHash) || typeof invite.label !== "string" ||
      typeof invite.revoked !== "boolean" || !Number.isSafeInteger(invite.expiresAt) ||
      !Number.isSafeInteger(invite.maxRequests) || invite.maxRequests < 1 ||
      !Number.isSafeInteger(invite.used) || invite.used < 0) ||
    new Set(ledger.invites.map((invite) => invite.id)).size !== ledger.invites.length ||
    ledger.used !== ledger.invites.reduce((sum, invite) => sum + invite.used, 0)) {
    throw new CredentialError("额度账本校验失败，代付已停止。请联系管理员。", 503);
  }
  return ledger;
}
export async function writeLedger(directory: string, ledger: Ledger) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `invites.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temporary, JSON.stringify(ledger), { mode: 0o600 });
  await rename(temporary, join(directory, "invites.json"));
}
export async function initializeLedger(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(join(directory, "invites.json"), JSON.stringify({ version: 1,
      secret: randomBytes(32).toString("hex"), used: 0, invites: [] }), { flag: "wx", mode: 0o600 });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

export class CredentialManager {
  #directory: string;
  #ownerKey: string;
  #globalLimit: number;
  #factory: (key: string, reserve?: () => Promise<void>) => RawModelGateway;
  #keys = new Map<string, { gateway: RawModelGateway; expiresAt: number }>();
  #queue = Promise.resolve();
  #timer: ReturnType<typeof setInterval>;
  constructor(options: { directory: string; ownerKey?: string; globalLimit?: number;
    factory?: (key: string, reserve?: () => Promise<void>) => RawModelGateway }) {
    this.#directory = options.directory;
    this.#ownerKey = options.ownerKey?.trim() ?? "";
    this.#globalLimit = options.globalLimit ?? 600;
    if (!Number.isSafeInteger(this.#globalLimit) || this.#globalLimit < 0) throw new Error("SPONSOR_MAX_REQUESTS 必须是非负整数");
    // No client-supplied URL, model, prompt, or provider options reach the gateway.
    this.#factory = options.factory ?? ((apiKey, beforeRequest) => new DeepSeekGateway({ apiKey, beforeRequest }));
    this.#timer = setInterval(() => {
      for (const [id, entry] of this.#keys) if (entry.expiresAt <= Date.now()) this.#keys.delete(id);
    }, 60_000);
    this.#timer.unref();
  }
  close() { clearInterval(this.#timer); this.#keys.clear(); }
  get invitesEnabled() { return !!this.#ownerKey && this.#globalLimit > 0; }
  forget(id: string) { this.#keys.delete(id); }
  async login(body: Record<string, unknown>): Promise<{ binding: CredentialBinding; token?: string; gateway?: RawModelGateway }> {
    if (body.kind === "byok") {
      const key = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      if (!/^[\x21-\x7e]{16,256}$/.test(key)) throw new CredentialError("请填写有效的 DeepSeek API Key。", 400);
      return { binding: { kind: "byok" }, gateway: this.#factory(key) };
    }
    if (body.kind !== "invite" || !this.invitesEnabled) throw new CredentialError("邀请码通道未开启，请使用自己的 API Key。");
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const ledger = await readLedger(this.#directory);
    const invite = ledger.invites.find((item) => item.codeHash === digest(code));
    if (!invite || invite.revoked || invite.expiresAt <= Date.now()) throw new CredentialError("邀请码无效、已撤销或已过期。", 401);
    // One invite always opens the SAME game, even across browsers or tunnel domains.
    return { binding: { kind: "invite", inviteId: invite.id }, token: createHmac("sha256", ledger.secret).update(invite.id).digest("hex") };
  }
  attach(id: string, gateway?: RawModelGateway) {
    if (gateway) this.#keys.set(id, { gateway, expiresAt: Date.now() + 30 * 60_000 });
  }
  ready(id: string, binding?: CredentialBinding) {
    if (binding?.kind === "invite") return this.invitesEnabled;
    return binding?.kind === "byok" && (this.#keys.get(id)?.expiresAt ?? 0) > Date.now();
  }
  async authorize(binding?: CredentialBinding) {
    if (binding?.kind !== "invite") return;
    const ledger = await readLedger(this.#directory);
    const invite = ledger.invites.find((item) => item.id === binding.inviteId);
    if (!invite || invite.revoked || invite.expiresAt <= Date.now()) throw new CredentialError("邀请码已撤销或过期。");
  }
  async gateway(id: string, binding?: CredentialBinding) {
    if (binding?.kind === "byok") {
      const entry = this.#keys.get(id);
      if (!entry || entry.expiresAt <= Date.now()) {
        this.forget(id); throw new CredentialError("API Key 已从内存释放，请重新输入后继续原局。", 428);
      }
      entry.expiresAt = Date.now() + 30 * 60_000;
      return entry.gateway;
    }
    if (binding?.kind !== "invite") throw new CredentialError("旧测试口令已停用，请选择自己的 Key 或新邀请码。", 428);
    await this.#check(binding.inviteId);
    return this.#factory(this.#ownerKey, () => this.#reserve(binding.inviteId));
  }
  async #check(id: string) {
    if (!this.invitesEnabled) throw new CredentialError("邀请人已关闭代付通道。");
    const ledger = await readLedger(this.#directory);
    const invite = ledger.invites.find((item) => item.id === id);
    if (!invite || invite.revoked || invite.expiresAt <= Date.now()) throw new CredentialError("邀请码已撤销或过期。");
    if (invite.used >= invite.maxRequests || ledger.used >= this.#globalLimit) throw new CredentialError("邀请码或邀请人总调用额度已用完。仍可整理资料与结案。", 429);
    return { ledger, invite };
  }
  async #reserve(id: string) {
    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await withLedgerLock(this.#directory, async () => {
        const { ledger, invite } = await this.#check(id);
        invite.used++; ledger.used++;
        // Persist BEFORE sending any paid HTTP request. Failures/retries also consume budget.
        await writeLedger(this.#directory, ledger);
      });
    } finally { release(); }
  }
}

export async function createInvite(directory: string, label: string, maxRequests = 120, days = 7) {
  if (!label.trim() || label.length > 80 || !Number.isSafeInteger(maxRequests) || maxRequests < 1 ||
    !Number.isSafeInteger(days) || days < 1 || days > 365) throw new Error("参数无效：备注 1—80 字，额度为正整数，有效期 1—365 天");
  await initializeLedger(directory);
  return withLedgerLock(directory, async () => {
    const ledger = await readLedger(directory);
    const code = randomBytes(24).toString("base64url");
    const invite: Invite = { id: randomBytes(8).toString("hex"), label: label.trim(), codeHash: digest(code),
      expiresAt: Date.now() + days * 86_400_000, revoked: false, maxRequests, used: 0 };
    ledger.invites.push(invite); await writeLedger(directory, ledger);
    return { id: invite.id, code };
  });
}

export async function revokeInvite(directory: string, id: string) {
  await withLedgerLock(directory, async () => {
    const ledger = await readLedger(directory);
    const invite = ledger.invites.find((item) => item.id === id);
    if (!invite) throw new Error("未找到邀请码 ID");
    invite.revoked = true; await writeLedger(directory, ledger);
  });
}
