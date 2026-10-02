import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInitialState } from "./seed.ts";
import { runGameTurn, OperationMismatchError } from "./turn.ts";
import { refreshCaseProgress, submitTreatmentConclusion } from "./engine.ts";
import { deliverAvailableMail, recordCaseNote, updateMailStatus } from "./casework.ts";
import { endingSummary } from "./endings.ts";
import { revealStory } from "./revelation.ts";
import type { RawModelGateway } from "./model.ts";
import type { SessionState, Operation } from "./types.ts";
import type { AnalyzerOutput } from "./contracts.ts";
import { CredentialError } from "./credentials.ts";
import type { CredentialManager, CredentialBinding } from "./credentials.ts";

type RecordData = {
  version: 1; revision: number; state: SessionState; createdAt: number;
  receipts: string[]; attempts: number; clueTurns?: Record<string, number>;
  credential?: CredentialBinding;
};
type Session = RecordData & {
  busy?: boolean; lastCall?: number;
  pending?: { id: string; revision: number; text: string; analysis: AnalyzerOutput };
};
class PublicError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const sameSecret = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const staticFiles: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
};

export function playerView(record: RecordData, mode: string) {
  const state = record.state;
  return {
    revision: record.revision, turn: state.turn, maxTurns: 25, mode,
    status: state.status, forcedOperation: state.forcedOperation,
    crisis: state.mode, conversation: state.conversation,
    clues: state.memories.flatMap((memory) => memory.fragments
      .filter((fragment) => fragment.disclosed)
      .map((fragment) => ({ id: fragment.id, text: fragment.text, reliability: fragment.reliability,
        ...(record.clueTurns?.[fragment.id] !== undefined ? { turn: record.clueTurns[fragment.id] } : {}),
      }))),
    mailbox: state.mailbox.filter((mail) => mail.status !== "unavailable")
      .map(({ id, from, subject, body, status, deliveredAtTurn }) => ({
        id, from, subject, status, deliveredAtTurn,
        ...(status === "read" ? { body } : {}),
      })),
    notes: state.caseNotes.map(({ id, text, createdAtTurn, focused }) => ({ id, text, createdAtTurn, focused })),
    ending: state.ending ? endingSummary(state) : null,
    lastRequestId: record.receipts.at(-1) ?? null,
  };
}

export async function createWebServer(options: {
  gateway?: RawModelGateway; accessCode?: string; dataDir: string; publicDir: string;
  credentials?: CredentialManager;
  mode?: string; maxSessions?: number; minTurnIntervalMs?: number;
}) {
  if (!options.credentials && (!options.gateway || !options.accessCode || options.accessCode.length < 8)) {
    throw new Error("离线演示需要 gateway 和至少 8 字符的口令；在线模式需要 credentials");
  }
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  const sessions = new Map<string, Session>();
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  for (const file of await readdir(options.dataDir)) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    const record = JSON.parse(await readFile(join(options.dataDir, file), "utf8")) as RecordData;
    if (record.version === 1 && record.createdAt > Date.now() - maxAgeMs) {
      sessions.set(file.slice(0, -5), record);
    }
  }
  const mode = options.mode ?? "DeepSeek 在线";
  const save = async (id: string, record: RecordData) => {
    const file = join(options.dataDir, `${id}.json`);
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify({
      version: 1, revision: record.revision, state: record.state, createdAt: record.createdAt,
      receipts: record.receipts, attempts: record.attempts, clueTurns: record.clueTurns,
      credential: record.credential,
    }), { mode: 0o600 });
    await rename(temporary, file);
  };
  let activeCalls = 0;
  let failedLogins = 0;
  let loginWindow = Date.now();
  let loginQueue = Promise.resolve();
  const view = (record: Session, id: string) => ({ ...playerView(record, mode),
    credentialKind: record.credential?.kind ?? (options.credentials ? "legacy" : "mock"),
    credentialRequired: options.credentials ? !options.credentials.ready(id, record.credential) : false });
  const routes: Record<string, string[]> = {
    "/api/login": ["kind", "apiKey", "code"], "/api/credentials": ["apiKey"], "/api/logout": [],
    "/api/turn": ["revision", "requestId", "operation", "text"],
    "/api/note": ["revision", "requestId", "text"],
    "/api/mail": ["revision", "requestId", "mailId", "status"],
    "/api/conclude": ["revision", "requestId", "disposition", "text", "confirm"], "/api/reveal": [],
  };

  const respond = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
  };
  const bodyOf = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      throw new PublicError(415, "请使用网页提交操作。");
    }
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 16_384) throw new PublicError(413, "输入过长，请缩短后再试。");
      chunks.push(chunk);
    }
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
      return data;
    } catch { throw new PublicError(400, "无法识别这次操作，请刷新后再试。"); }
  };
  const textOf = (body: Record<string, unknown>, key: string, max = 1200) => {
    const text = typeof body[key] === "string" ? body[key].trim() : "";
    if (!text || text.length > max) throw new PublicError(400, `请填写 1—${max} 字的内容。`);
    return text;
  };
  const server = createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && staticFiles[path]) {
        const [file, mime] = staticFiles[path];
        const content = await readFile(join(options.publicDir, file));
        response.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
        response.end(content); return;
      }
      if (!path.startsWith("/api/")) throw new PublicError(404, "没有这个页面。");
      if (!["GET", "POST"].includes(request.method ?? "")) throw new PublicError(405, "不支持此操作。");
      if (request.headers["sec-fetch-site"] === "cross-site") throw new PublicError(403, "请从试玩页面内操作。");
      if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) {
        throw new PublicError(403, "请从试玩页面内操作。");
      }
      if (path === "/api/info" && request.method === "GET") {
        respond(response, 200, { mode, byok: !!options.credentials, invites: options.credentials?.invitesEnabled ?? false }); return;
      }
      const body = request.method === "POST" ? await bodyOf(request) : {};
      if (request.method === "POST") {
        if (!routes[path]) throw new PublicError(404, "没有这个操作。");
        if (Object.keys(body).some((key) => !routes[path].includes(key))) throw new PublicError(400, "请求包含不支持的字段。");
      }
      if (path === "/api/login" && request.method === "POST") {
        if (Date.now() - loginWindow > 60_000) { failedLogins = 0; loginWindow = Date.now(); }
        if (failedLogins >= 20) throw new PublicError(429, "口令尝试过多，请一分钟后再试。");
        if (!options.credentials && !sameSecret(typeof body.code === "string" ? body.code : "", options.accessCode!)) {
          failedLogins++; throw new PublicError(401, "测试口令不正确。");
        }
        // Serialize slot allocation so simultaneous logins cannot exceed the tester limit.
        const previous = loginQueue; let release!: () => void;
        loginQueue = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
          for (const [id, record] of sessions) if (record.createdAt < Date.now() - maxAgeMs && !record.busy) sessions.delete(id);
          const existingToken = request.headers.cookie?.match(/(?:^|;\s*)memory_session=([a-f0-9]{64})(?:;|$)/)?.[1];
          let token = existingToken; let record = token ? sessions.get(hash(token)) : undefined;
          let authorization: Awaited<ReturnType<CredentialManager["login"]>> | undefined;
          if (options.credentials) {
            try { authorization = await options.credentials.login(body); }
            catch (error) { failedLogins++; throw error; }
            if (authorization.token) {
              token = authorization.token; record = sessions.get(hash(token));
              // An expired invite game must not reset its 25-turn/60-attempt limits.
              if (!record) {
                try { record = JSON.parse(await readFile(join(options.dataDir, `${hash(token)}.json`), "utf8")); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
              }
            } else if (record?.credential?.kind === "invite") { token = undefined; record = undefined; }
            if (record?.busy) throw new PublicError(409, "会谈正在处理中，请稍后登录。");
          }
          if (!record) {
            if (sessions.size >= (options.maxSessions ?? 30)) throw new PublicError(429, "本次内测名额已满，请联系发起人。");
            token = authorization?.token ?? randomBytes(32).toString("hex");
            record = { version: 1, revision: 0, state: createInitialState(), createdAt: Date.now(), receipts: [], attempts: 0, clueTurns: { orange_scene: 0 } };
          }
          if (authorization) record.credential = authorization.binding;
          // Refresh login lifetime without resetting gameplay or paid-request counters.
          record.createdAt = Date.now();
          await save(hash(token!), record); sessions.set(hash(token!), record);
          options.credentials?.attach(hash(token!), authorization?.gateway);
          const secure = request.headers["x-forwarded-proto"] === "https";
          response.setHeader("Set-Cookie", `memory_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure ? "; Secure" : ""}`);
          respond(response, 200, view(record, hash(token!)));
        } finally { release(); }
        return;
      }
      const token = request.headers.cookie?.match(/(?:^|;\s*)memory_session=([a-f0-9]{64})(?:;|$)/)?.[1];
      const id = token ? hash(token) : "";
      const record = sessions.get(id);
      if (!record || record.createdAt < Date.now() - maxAgeMs) throw new PublicError(401, "请填写测试口令，进入会谈。");
      if (path !== "/api/logout") await options.credentials?.authorize(record.credential);
      if (request.method === "GET") {
        if (path !== "/api/session") throw new PublicError(404, "没有这个接口。");
        respond(response, 200, { ...view(record, id), busy: !!record.busy }); return;
      }
      if (path === "/api/logout") {
        if (record.busy) throw new PublicError(409, "伊莱正在回应，请稍候再退出。");
        options.credentials?.forget(id);
        response.setHeader("Set-Cookie", "memory_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
        respond(response, 200, { ok: true }); return;
      }
      if (path === "/api/credentials") {
        if (!options.credentials || record.credential?.kind !== "byok") throw new PublicError(403, "该会话不接受更换 Key。");
        if (record.busy) throw new PublicError(409, "伊莱正在回应，请稍候。");
        const login = await options.credentials.login({ kind: "byok", apiKey: body.apiKey });
        options.credentials.attach(id, login.gateway); respond(response, 200, view(record, id)); return;
      }
      if (path === "/api/reveal") {
        if (!record.state.ending) throw new PublicError(403, "会谈结束后才能查看故事背景。");
        respond(response, 200, { text: revealStory(record.state) }); return;
      }
      if (record.busy) throw new PublicError(409, "伊莱正在回应，请稍候。", { busy: true });
      const requestId = textOf(body, "requestId", 80);
      if (!/^[\w-]{8,80}$/.test(requestId)) throw new PublicError(400, "请求标识无效。");
      if (record.receipts.includes(requestId)) { respond(response, 200, view(record, id)); return; }
      if (body.revision !== record.revision) throw new PublicError(409, "会谈已更新，请刷新记录后重试。", { refresh: true });
      record.busy = true;
      try {
        let state = record.state;
        if (path === "/api/turn") {
          if (state.ending || state.turn >= 25) throw new PublicError(409, "患者通道已关闭，可以整理资料并结案。");
          const operation = body.operation as Operation;
          if (!["inquire", "empathize", "suggest"].includes(operation)) throw new PublicError(400, "请选择会谈方式。");
          if (state.forcedOperation && operation !== state.forcedOperation) throw new PublicError(409, "当前危机需要先用共情处理。");
          const text = textOf(body, "text");
          if (/^\d+$/.test(text)) throw new PublicError(400, "请写下一句对伊莱说的话。");
          if (record.attempts >= 60) throw new PublicError(429, "本局请求额度已用完，仍可查看资料和结案。");
          if (Date.now() - (record.lastCall ?? 0) < (options.minTurnIntervalMs ?? 2500)) throw new PublicError(429, "请稍等几秒再发送。");
          if (activeCalls >= 3) throw new PublicError(429, "其他会谈正在进行，请稍后重试。");
          const gateway = options.credentials ? await options.credentials.gateway(id, record.credential) : options.gateway!;
          if (activeCalls >= 3) throw new PublicError(429, "其他会谈正在进行，请稍后重试。");
          record.lastCall = Date.now(); record.attempts++;
          activeCalls++;
          try {
            await save(id, record);
            const pending = record.pending;
            const preAnalyzed = pending?.id === requestId && pending.revision === record.revision && pending.text === text
              && pending.analysis.operation === operation ? pending.analysis : undefined;
            const result = await runGameTurn(state, operation, text, gateway, { allowFallback: false, preAnalyzed });
            if (result.resolution.errors.length) throw new PublicError(422, "本次干预无法应用，请重新措辞；回合未消耗。");
            state = result.resolution.state;
          } catch (error) {
            if (error instanceof OperationMismatchError) {
              record.pending = { id: requestId, revision: record.revision, text, analysis: error.analysis };
              throw new PublicError(422, error.explanation, { detectedOperation: error.detectedOperation });
            }
            if (error instanceof PublicError || error instanceof CredentialError) throw error;
            if (error instanceof Error && error.cause instanceof CredentialError) throw error.cause;
            // Provider bodies and hidden memory identifiers must never reach browser/log output.
            const detail = error instanceof Error ? error.message : "";
            const reason = detail.includes("invalid_implant") ? "这句话的记忆变更未能解析，请换一种说法。"
              : detail.includes("401") ? "服务端的 API 凭据需要检查，请联系发起人。"
              : detail.includes("402") ? "服务端 API 额度不足，请联系发起人。"
              : "本次回应未能完成，请稍后重试。";
            throw new PublicError(502, `${reason} 本回合未提交，草稿已保留。`);
          } finally { activeCalls--; }
        } else if (path === "/api/note") {
          if (state.ending) throw new PublicError(409, "会谈已结案，笔记已归档。");
          if (state.caseNotes.length >= 200) throw new PublicError(429, "本局研判记录已达 200 条上限。");
          state = refreshCaseProgress(recordCaseNote(state, textOf(body, "text"))).state;
        } else if (path === "/api/mail") {
          const mailId = textOf(body, "mailId", 100);
          if (!state.mailbox.some((mail) => mail.id === mailId && mail.status !== "unavailable")) throw new PublicError(404, "这封邮件尚未送达。");
          if (!["read", "ignored"].includes(String(body.status))) throw new PublicError(400, "无效的邮件操作。");
          state = updateMailStatus(state, mailId, body.status as "read" | "ignored");
        } else if (path === "/api/conclude") {
          if (body.confirm !== true) throw new PublicError(400, "请先确认是否结束本次会谈。");
          if (!["defer", "interpret", "stop"].includes(String(body.disposition))) throw new PublicError(400, "请选择结案方式。");
          if (body.disposition === "stop") {
            if (state.ending || state.turn < 25) throw new PublicError(409, "目前可以选择暂不定论，或继续会谈。");
            state = structuredClone(state); state.ending = { type: "treatment_interrupted", quality: "fragile" };
          } else {
            const result = submitTreatmentConclusion(state, textOf(body, "text"), body.disposition as "defer" | "interpret");
            if (!result.accepted || !result.state.ending) {
              const messages: Record<string, string> = {
                no_session_yet: "先完成一次交流，再决定是否暂缓判断。",
                crisis_unresolved: "请先用共情处理当前危机。",
                conclusion_too_early: "暂不能提交最终解释；可继续调查，或选择暂不定论。",
                already_ended: "本局已经结束。",
              };
              throw new PublicError(409, messages[result.reason] ?? "尚未满足正式结案条件，可以选择暂不定论。");
            }
            state = result.state;
          }
        } else throw new PublicError(404, "没有这个操作。");
        const clueTurns = { ...record.clueTurns };
        const previousClues = new Set(record.state.memories.flatMap((m) => m.fragments.filter((f) => f.disclosed).map((f) => f.id)));
        for (const fragment of state.memories.flatMap((m) => m.fragments)) {
          if (fragment.disclosed && !previousClues.has(fragment.id)) clueTurns[fragment.id] = state.turn;
        }
        const next: RecordData = {
          version: 1, revision: record.revision + 1, state: deliverAvailableMail(state).state,
          createdAt: record.createdAt, attempts: record.attempts,
          receipts: [...record.receipts, requestId].slice(-100), clueTurns,
          credential: record.credential,
        };
        await save(id, next); Object.assign(record, next); record.pending = undefined;
        respond(response, 200, view(record, id));
      } finally { record.busy = false; }
    } catch (error) {
      if (error instanceof CredentialError) respond(response, error.status, { error: error.message });
      else if (error instanceof PublicError) respond(response, error.status, { error: error.message, ...error.extra });
      else respond(response, 500, { error: "会谈暂时无法保存，请联系发起人；不要关闭仍有草稿的页面。" });
    }
  });
  server.requestTimeout = 240_000;
  server.headersTimeout = 30_000;
  return server;
}
