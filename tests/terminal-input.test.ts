import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import test from "node:test";
import { createTerminalInput } from "../src/terminal-input.ts";

test("Esc cancels immediately and discards partially typed text", { timeout: 3000 }, async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const terminal = createTerminalInput(input, output, true);
  try {
    const first = terminal.question("first > ");
    input.write("unfinished draft\x1b");
    assert.equal(await first, null);
    const second = terminal.question("second > ");
    input.write("new answer\r");
    assert.equal(await second, "new answer");
  } finally { terminal.close(); }
});

test("Arrow keys edit text without triggering Esc cancellation", { timeout: 3000 }, async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const terminal = createTerminalInput(input, output, true);
  try {
    const answer = terminal.question("> ");
    input.write("abc\x1b[DX\r");
    assert.equal(await answer, "abXc");
    const cancelled = terminal.question("> ");
    input.write("/返回\r");
    assert.equal(await cancelled, null);
  } finally { terminal.close(); }
});

test("CLI cancellation preserves turns and notes, including the final conclusion at turn 25", { timeout: 10000 }, async () => {
  const { NODE_TEST_CONTEXT: _testContext, ...childEnvironment } = process.env;
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/cli.ts", "--mock"], {
    cwd: new URL("../", import.meta.url), stdio: ["pipe", "pipe", "pipe"], env: childEnvironment,
  });
  let output = "";
  let cursor = 0;
  let notify = () => {};
  child.stdout.on("data", (chunk) => { output += chunk.toString(); notify(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); notify(); });
  const waitFor = (text: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Missing ${text}\n${output}`)), 3000);
    notify = () => {
      const index = output.indexOf(text, cursor);
      if (index < 0) return;
      cursor = index + text.length;
      clearTimeout(timer);
      resolve();
    };
    notify();
  });
  const send = (text: string) => child.stdin.write(`${text}\n`);
  try {
    await waitFor("选择操作：");
    send("/研讨");
    await waitFor("写下你的私人判断");
    send("/返回");
    await waitFor("已取消研判");
    send("/笔记");
    await waitFor("尚未记录判断");
    send("1");
    await waitFor("你对伊莱说");
    send("/返回");
    await waitFor("本回合未消耗");
    assert.equal(output.includes("系统正在核对"), false);
    send("/结案");
    await waitFor("写下你的正式治疗结论");
    send("/返回");
    await waitFor("已取消结案");
    send("1");
    await waitFor("你对伊莱说");
    send("也许那个人是你的家人。");
    await waitFor("操作不匹配");
    send("/返回");
    await waitFor("本回合未消耗");
    send("3");
    await waitFor("你对伊莱说");
    send("也许那个人是你的家人。");
    await waitFor("第 2 回合");
    assert.equal(output.includes("第 3 回合"), false);
    assert.equal(output.includes("会话结局"), false);
    for (let turn = 2; turn <= 25; turn++) {
      const empathize = turn % 2 === 0;
      send(empathize ? "2" : "1");
      await waitFor("你对伊莱说");
      send(empathize ? "没关系，我们慢慢来。" : "你还记得什么？");
      await waitFor(turn === 25 ? "治疗回合已达上限" : `第 ${turn + 1} 回合`);
    }
    send("/结案");
    await waitFor("写下你的正式治疗结论");
    send("/返回");
    await waitFor("已取消结案");
    send("/线索");
    await waitFor("治疗记录·已知线索");
    send("/结案");
    await waitFor("写下你的正式治疗结论");
    send("这些记忆来自不同的人。");
    await waitFor("提交后将结束会谈");
    send("/返回");
    await waitFor("已取消结案");
    assert.equal(output.includes("会话结局"), false);
    assert.equal(output.includes("第 26 回合"), false);
    send("/结案");
    await waitFor("写下你的正式治疗结论");
    send("这些记忆来自不同的人。");
    await waitFor("提交后将结束会谈");
    send("确认");
    await waitFor("会话结局：");
    await waitFor("结局之后：");
    assert.equal(output.includes("【故事底稿"), false);
    send("1");
    await waitFor("【故事底稿 · 完整剧透】");
    await waitFor("不会改变本局结局");
    await waitFor("结局之后：");
    send("2");
  } finally { child.kill(); }
});
