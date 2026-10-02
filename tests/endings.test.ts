import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { createInitialState } from "../src/seed.ts";
import { submitTreatmentConclusion } from "../src/engine.ts";
import { endingSummary } from "../src/endings.ts";
import { revealStory } from "../src/revelation.ts";
import { createTerminalInput } from "../src/terminal-input.ts";
import { writeTypewriter } from "../src/typewriter.ts";

test("暂不定论不依赖真相词语，也不更改患者记忆或状态", () => {
  const initial = createInitialState();
  initial.turn = 1;
  const snapshot = structuredClone(initial);
  const result = submitTreatmentConclusion(initial, "现有资料不足，保留解释。", "defer");
  assert.equal(result.accepted, true);
  assert.equal(result.state.ending?.type, "open_question");
  assert.equal(endingSummary(result.state).title, "带着疑问离开");
  assert.deepEqual(result.state.claims, snapshot.claims);
  assert.deepEqual(result.state.memories, snapshot.memories);
  assert.deepEqual(result.state.status, snapshot.status);
  assert.equal(result.state.stage, snapshot.stage);
  assert.deepEqual(initial, snapshot);
});

test("暂不定论不能跳过危机，也不能重写已经发生的结局", () => {
  const state = createInitialState();
  assert.equal(submitTreatmentConclusion(state, "资料不足。", "defer").reason, "no_session_yet");
  state.turn = 3;
  state.mode = "collapse";
  state.forcedOperation = "empathize";
  assert.equal(submitTreatmentConclusion(state, "资料不足。", "defer").reason, "crisis_unresolved");
  state.ending = { type: "treatment_interrupted", quality: "fragile" };
  assert.equal(submitTreatmentConclusion(state, "资料不足。", "defer").reason, "already_ended");
});

test("完整背景仅在结局后开放，所有结局共享真相且揭底不改变状态", () => {
  const state = createInitialState();
  assert.throws(() => revealStory(state), /revelation_requires_ending/);
  for (const type of ["truth_healing", "false_happiness", "open_question", "treatment_interrupted"] as const) {
    state.ending = { type, quality: "stable" };
    const snapshot = structuredClone(state);
    const text = revealStory(state);
    assert.match(text, /AI 实验体/);
    assert.match(text, /罗遥、周衡和苏眠/);
    assert.match(text, /研究方/);
    assert.match(text, /【本局记录】/);
    assert.deepEqual(state, snapshot);
  }
});

test("结局中的悬念仅引用已公开可靠线索，不提前泄露其他路线", () => {
  const state = createInitialState();
  for (const type of ["truth_healing", "false_happiness", "open_question", "treatment_interrupted"] as const) {
    state.ending = { type, quality: "stable" };
    const snapshot = structuredClone(state);
    const text = endingSummary(state).text;
    assert.match(text, /厨房里削橙子的人/);
    assert.doesNotMatch(text, /玻璃后|录音机|站台上|AI|实验体|罗遥|周衡|苏眠/);
    assert.deepEqual(state, snapshot);
  }
  const glass = state.memories.flatMap((memory) => memory.fragments)
    .find((fragment) => fragment.id === "glass_name")!;
  glass.disclosed = true;
  glass.reliability = "player_influenced";
  assert.doesNotMatch(endingSummary(state).text, /玻璃后/);
  glass.reliability = "grounded";
  assert.match(endingSummary(state).text, /玻璃后呼唤伊莱的人/);
});

test("逐字播放可以跳过动画且保留完整 Unicode 文本", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk; });
  const result = writeTypewriter(input, output, "伊莱🙂的过去", { terminal: true, delayMs: 1000 });
  assert.equal(rendered, "伊");
  input.emit("keypress", " ", { name: "space", sequence: " " });
  assert.equal(await result, "complete");
  assert.equal(rendered, "伊莱🙂的过去\n");
  assert.equal(input.listenerCount("keypress"), 0);
});

test("Esc 停止揭底，返回后的菜单输入不受逐字播放影响", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk; });
  const terminal = createTerminalInput(input, output, true);
  try {
    const result = terminal.typewrite("首字之后的内容不应继续输出");
    input.emit("keypress", "\u001b", { name: "escape", sequence: "\u001b" });
    assert.equal(await result, "cancelled");
    assert.equal(rendered, "首\n");
    const next = terminal.question("结局菜单 > ");
    input.write("2\r");
    assert.equal(await next, "2");
  } finally { terminal.close(); }
});
