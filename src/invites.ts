import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInvite, initializeLedger, readLedger, revokeInvite } from "./credentials.ts";

const directory = resolve(process.env.PLAYTEST_DATA_DIR || fileURLToPath(new URL("../data/online", import.meta.url)));
const [command, value, amount, days] = process.argv.slice(2);
await initializeLedger(directory);
try {
  if (command === "create") {
    const invite = await createInvite(directory, value || "测试者", Number(amount || 120), Number(days || 7));
    console.log(`邀请码 ID：${invite.id}\n邀请码（仅本次显示，请私下发送）：${invite.code}\n一码绑定一局；同码登录会恢复同一局，请勿共用。`);
  } else if (command === "list") {
    const ledger = await readLedger(directory);
    console.log(`所有邀请码累计上游请求：${ledger.used}`);
    console.table(ledger.invites.map(({ id, label, used, maxRequests, expiresAt, revoked }) => ({
      id, label, used, maxRequests, expires: new Date(expiresAt).toISOString(), revoked,
    })));
  } else if (command === "revoke" && value) {
    await revokeInvite(directory, value); console.log("已撤销该邀请码，之后的上游请求将被拒绝。");
  } else {
    console.log("用法：npm run invite -- create [备注] [上游请求上限=120] [天数=7]\n      npm run invite -- list\n      npm run invite -- revoke <邀请码ID>");
  }
} catch (error) { console.error(error instanceof Error ? error.message : "操作失败"); process.exitCode = 1; }
