import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createWebServer } from "./web-server.ts";
import { MockGateway } from "./model.ts";
import { CredentialManager, initializeLedger } from "./credentials.ts";

const mock = process.argv.includes("--mock");
const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
const accessCode = process.env.PLAYTEST_CODE || randomBytes(9).toString("base64url");
const port = Number(process.env.PLAYTEST_PORT || 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PLAYTEST_PORT 无效");
const dataDir = resolve(process.env.PLAYTEST_DATA_DIR || fileURLToPath(new URL(mock ? "../data/mock" : "../data/online", import.meta.url)));
await initializeLedger(dataDir);
const credentials = mock ? undefined : new CredentialManager({ directory: dataDir,
  ownerKey: apiKey, globalLimit: Number(process.env.SPONSOR_MAX_REQUESTS ?? 600) });
const server = await createWebServer({
  ...(mock ? { gateway: new MockGateway(), accessCode } : { credentials }),
  dataDir,
  publicDir: fileURLToPath(new URL("../web/", import.meta.url)),
  mode: mock ? "离线演示" : "DeepSeek 在线",
});
server.listen(port, "127.0.0.1", () => {
  console.log(`\n记忆编辑师 · 手机试玩\n本机地址：http://127.0.0.1:${port}\n${mock ? `离线演示口令：${accessCode}` : "登录方式：玩家自己的 DeepSeek API Key"}\n${credentials?.invitesEnabled ? "代付通道已开启；使用 npm run invite -- create 生成独立邀请码。" : "不提供邀请人代付。"}\n默认最多 30 个浏览器会话，每局最多 25 回合、60 次尝试。\n在线模式固定调用 DeepSeek 官方接口，不接受自定义上游地址。\n`);
});
server.on("close", () => credentials?.close());
const shutdown = () => { server.close(); server.closeIdleConnections(); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
