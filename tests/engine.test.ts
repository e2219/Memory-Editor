import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import {
  calculateConflictPressure,
  refreshCaseProgress,
  resolveTurn,
  submitTreatmentConclusion,
} from "../src/engine.ts";
import { createInitialState } from "../src/seed.ts";
import { MockGateway } from "../src/model.ts";
import type { RawModelGateway } from "../src/model.ts";
import { DeepSeekGateway } from "../src/deepseek.ts";
import { buildAnalyzerRequest, buildNarratorRequest } from "../src/context.ts";
import { OperationMismatchError, runGameTurn } from "../src/turn.ts";
import type { SessionState, TurnIntent } from "../src/types.ts";
import {
  deliverAvailableMail,
  focusCaseNote,
  recordCaseNote,
  updateMailStatus,
} from "../src/casework.ts";

const stationSuggestion: TurnIntent = {
  operation: "suggest",
  magnitude: "medium",
  tone: "supportive",
  targetMemoryId: "mem_02_rain_station",
  claimId: "claim_station_waiting_for_mother",
  claimDirection: "strengthen",
};

const claimConfidence = (state: SessionState, id: string): number => {
  const claim = state.claims.find((candidate) => candidate.id === id);
  assert.ok(claim, `missing claim ${id}`);
  return claim.confidence;
};

test("同一状态和输入产生完全相同的结果", () => {
  const state = createInitialState();
  assert.deepEqual(resolveTurn(state, stationSuggestion), resolveTurn(state, stationSuggestion));
});

test("阶段只会因玩家研判和已公开证据推进，不再按回合强制跳转", () => {
  let state = createInitialState();
  for (let turn = 1; turn <= 7; turn += 1) {
    state = resolveTurn(state, {
      operation: turn % 2 === 0 ? "empathize" : "inquire",
      magnitude: "small",
      tone: "supportive",
      targetMemoryId: "mem_01_orange_peel",
      claimId: "claim_orange_is_mine",
    }).state;
    assert.equal(state.stage, 1, `unexpected transition at turn ${turn}`);
  }

  const orange = state.memories.find((memory) => memory.id === "mem_01_orange_peel")!;
  const station = state.memories.find((memory) => memory.id === "mem_02_rain_station")!;
  for (const fragment of orange.fragments.filter((item) => !item.contaminationOnly)) {
    fragment.disclosed = true;
  }
  station.fragments.find((fragment) => fragment.id === "station_red_boots")!.disclosed = true;
  state = recordCaseNote(state, "厨房和站台像两段被强行拼接的记忆");
  state = resolveTurn(state, {
    operation: "empathize",
    magnitude: "small",
    tone: "supportive",
    targetMemoryId: "mem_01_orange_peel",
    claimId: "claim_orange_is_mine",
  }).state;
  assert.equal(state.stage, 2);
});

test("拒绝把不属于目标记忆的主张串接进来", () => {
  const state = createInitialState();
  const result = resolveTurn(state, {
    operation: "suggest",
    magnitude: "medium",
    tone: "supportive",
    targetMemoryId: "mem_01_orange_peel",
    claimId: "claim_station_waiting_for_mother",
    claimDirection: "strengthen",
  });

  assert.deepEqual(result.errors, ["claim_memory_mismatch"]);
  assert.deepEqual(result.state, state);
});

test("高信任比低信任更容易接受同一句暗示", () => {
  const lowTrust = createInitialState();
  lowTrust.status.trust = 5;
  lowTrust.status.stability = 30;

  const highTrust = createInitialState();
  highTrust.status.trust = 90;
  highTrust.status.stability = 70;

  const low = resolveTurn(lowTrust, stationSuggestion);
  const high = resolveTurn(highTrust, stationSuggestion);

  assert.ok((high.acceptanceScore ?? 0) > (low.acceptanceScore ?? 0));
  assert.equal(low.accepted, false);
  assert.equal(high.accepted, true);
});

test("共情错误记忆会强化它，但弱于直接暗示", () => {
  const base = createInitialState();
  base.status.trust = 90;

  const empathy = resolveTurn(base, {
    operation: "empathize",
    magnitude: "medium",
    tone: "supportive",
    targetMemoryId: "mem_01_orange_peel",
    claimId: "claim_orange_is_mine",
    implicitFactConfirmation: true,
  });
  const suggestion = resolveTurn(base, {
    operation: "suggest",
    magnitude: "medium",
    tone: "supportive",
    targetMemoryId: "mem_01_orange_peel",
    claimId: "claim_orange_is_mine",
    claimDirection: "strengthen",
  });

  const before = claimConfidence(base, "claim_orange_is_mine");
  const empathyGain = claimConfidence(empathy.state, "claim_orange_is_mine") - before;
  const suggestionGain = claimConfidence(suggestion.state, "claim_orange_is_mine") - before;

  assert.ok(empathyGain > 0);
  assert.ok(suggestionGain > empathyGain);
});

test("连贯的错误暗示会降低辨别清晰度，同时降低真相一致度", () => {
  const state = createInitialState();
  state.status.trust = 90;
  const beforeTruth = state.hidden.truthAlignment;
  const beforeClarity = state.status.clarity;

  const result = resolveTurn(state, {
    operation: "suggest",
    magnitude: "large",
    tone: "supportive",
    targetMemoryId: "mem_01_orange_peel",
    claimId: "claim_orange_is_mine",
    claimDirection: "strengthen",
  });

  assert.ok(result.state.status.clarity < beforeClarity);
  assert.ok(result.state.hidden.truthAlignment < beforeTruth);
});

test("询问可以暴露冲突：清晰上升而稳定下降", () => {
  const state = createInitialState();
  const beforeStability = state.status.stability;
  const beforeClarity = state.status.clarity;

  const result = resolveTurn(state, {
    operation: "inquire",
    magnitude: "large",
    tone: "neutral",
    targetMemoryId: "mem_02_rain_station",
    claimId: "claim_station_waiting_for_stranger",
  });

  assert.ok(calculateConflictPressure(result.state) > 0);
  assert.ok(result.state.status.clarity > beforeClarity);
  assert.ok(result.state.status.stability < beforeStability);
});

test("最多允许两个植入节点，且弱化不会删除节点", () => {
  let state = createInitialState();
  state.status.trust = 100;

  for (let index = 1; index <= 2; index += 1) {
    state = resolveTurn(state, {
      operation: "suggest",
      magnitude: "large",
      tone: "supportive",
      targetMemoryId: "mem_01_orange_peel",
      implant: {
        summary: `植入记忆 ${index}`,
        linkedMemoryId: "mem_01_orange_peel",
        claimLabel: `植入主张 ${index}`,
      },
    }).state;
  }

  const third = resolveTurn(state, {
    operation: "suggest",
    magnitude: "large",
    tone: "supportive",
    targetMemoryId: "mem_01_orange_peel",
    implant: {
      summary: "第三段植入记忆",
      linkedMemoryId: "mem_01_orange_peel",
      claimLabel: "第三个植入主张",
    },
  });

  assert.equal(state.memories.filter((memory) => memory.kind === "implant").length, 2);
  assert.deepEqual(third.errors, ["implant_limit_reached"]);

  const weakened = resolveTurn(state, {
    operation: "suggest",
    magnitude: "large",
    tone: "supportive",
    targetMemoryId: "mem_implant_1",
    claimId: "claim_implant_1",
    claimDirection: "weaken",
  });
  assert.ok(weakened.state.memories.some((memory) => memory.id === "mem_implant_1"));
  assert.ok(
    claimConfidence(weakened.state, "claim_implant_1") <=
      claimConfidence(state, "claim_implant_1"),
  );
});

test("被抗拒的植入建议不会提前创建节点", () => {
  const state = createInitialState();
  state.status.trust = 0;
  state.status.stability = 20;

  const result = resolveTurn(state, {
    operation: "suggest",
    magnitude: "large",
    tone: "pressuring",
    targetMemoryId: "mem_01_orange_peel",
    implant: {
      summary: "你曾在这里见过另一个人",
      linkedMemoryId: "mem_01_orange_peel",
      claimLabel: "橙皮记忆中还有另一个人",
    },
  });

  assert.equal(result.accepted, false);
  assert.equal(result.state.memories.some((memory) => memory.kind === "implant"), false);
  assert.equal(result.state.claims.some((claim) => claim.origin === "player_implanted"), false);
});

test("崩溃状态只接受共情，并在共情后恢复", () => {
  const state = createInitialState();
  state.mode = "collapse";
  state.forcedOperation = "empathize";
  state.status.stability = 12;

  const blocked = resolveTurn(state, stationSuggestion);
  assert.deepEqual(blocked.errors, ["operation_forced:empathize"]);
  assert.equal(blocked.state.turn, state.turn);

  const recovered = resolveTurn(state, {
    operation: "empathize",
    magnitude: "medium",
    tone: "supportive",
    targetMemoryId: "mem_07_missed_call",
  });
  assert.equal(recovered.state.mode, "normal");
  assert.equal(recovered.state.forcedOperation, null);
  assert.ok(recovered.state.status.stability >= 25);
  assert.equal(recovered.state.rescueUsed.stability, true);
});

test("连续第三次询问触发疲劳且不再产出新线索", () => {
  let state = createInitialState();
  const intent: TurnIntent = {
    operation: "inquire",
    magnitude: "small",
    tone: "neutral",
    targetMemoryId: "mem_01_orange_peel",
    claimId: "claim_orange_is_mine",
  };
  state = resolveTurn(state, intent).state;
  state = resolveTurn(state, intent).state;
  const third = resolveTurn(state, intent);

  assert.ok(third.changes.includes("intervention_fatigue:inquire"));
  assert.deepEqual(third.newClues, []);
  assert.equal(third.state.status.trust, state.status.trust);
});

test("连续询问前五次不扣信任，第六次才扣减，切换操作后重新计数", () => {
  for (const tone of ["neutral", "supportive", "pressuring"] as const) {
    for (const focus of ["memory", "present_context"] as const) {
      let state = createInitialState();
      state.status.stability = 100;
      const intent: TurnIntent = {
        operation: "inquire", magnitude: "small", tone, focus,
        ...(focus === "memory" ? { targetMemoryId: "mem_01_orange_peel", claimId: "claim_orange_is_mine" } : {}),
      };
      for (let count = 1; count <= 6; count++) {
        const previous = state.status.trust;
        const result = resolveTurn(state, intent);
        assert.deepEqual(result.errors, []);
        state = result.state;
        if (count <= 5) assert.equal(state.status.trust, previous + (tone === "supportive" ? 1 : 0));
        else if (focus === "memory" || tone === "pressuring") assert.ok(state.status.trust < previous);
      }
      state = resolveTurn(state, { ...intent, operation: "empathize", tone: "supportive" }).state;
      const previous = state.status.trust;
      state = resolveTurn(state, { ...intent, tone: "pressuring" }).state;
      assert.equal(state.intervention.streak, 1);
      assert.equal(state.status.trust, previous);
    }
  }
});

test("低稳定询问只会披露预设的未核实污染线索", () => {
  const state = createInitialState();
  state.status.stability = 38;
  const result = resolveTurn(state, {
    operation: "inquire",
    magnitude: "small",
    tone: "neutral",
    targetMemoryId: "mem_01_orange_peel",
    claimId: "claim_orange_is_mine",
  });

  assert.deepEqual(result.newClues.map((clue) => clue.fragmentId), ["unstable_orange_ring"]);
  assert.ok(result.changes.includes("unstable_clue_disclosed"));
  assert.equal(
    result.state.memories
      .find((memory) => memory.id === "mem_01_orange_peel")!
      .fragments.find((fragment) => fragment.id === "unstable_orange_ring")!
      .reliability,
    "unstable",
  );
});

test("来源权重漂移后仍归一化为 1", () => {
  const state = createInitialState();
  state.status.trust = 100;
  const beforeLuoyao = state.sources.find((source) => source.id === "src_luoyao")!.weight;

  const result = resolveTurn(state, {
    operation: "suggest",
    magnitude: "large",
    tone: "supportive",
    targetMemoryId: "mem_01_orange_peel",
    claimId: "claim_orange_is_mine",
    claimDirection: "strengthen",
  });

  const total = result.state.sources.reduce((sum, source) => sum + source.weight, 0);
  const afterLuoyao = result.state.sources.find((source) => source.id === "src_luoyao")!.weight;
  assert.ok(Math.abs(total - 1) < 1e-12);
  assert.ok(afterLuoyao > beforeLuoyao);
});

test("提交治疗结论后才能确定性结算真相治愈", () => {
  const state = createInitialState();
  state.turn = 14;
  state.stage = 3;
  state.progress.submittedConclusion = "这些记忆并非都属于伊莱，但他可以选择如何面对它们。";
  state.status = { trust: 40, stability: 80, clarity: 90 };
  state.sources[0]!.weight = 0.34;
  state.sources[1]!.weight = 0.33;
  state.sources[2]!.weight = 0.33;

  for (const claim of state.claims) {
    if (claim.canonicalStatus === "true") {
      claim.active = true;
      claim.confidence = 100;
    }
    if (claim.canonicalStatus === "false") {
      claim.confidence = 0;
    }
  }

  const result = resolveTurn(state, {
    operation: "inquire",
    magnitude: "small",
    tone: "supportive",
    targetMemoryId: "mem_10_replace_the_pain",
    claimId: "claim_accept_composite_identity",
  });

  assert.equal(result.state.ending?.type, "truth_healing");
  assert.equal(result.state.ending?.variant, undefined);
});

test("虚假幸福按主导来源选择人格变体", () => {
  const state = createInitialState();
  state.turn = 14;
  state.stage = 3;
  state.progress.submittedConclusion = "让伊莱相信橙皮记忆就是自己的童年。";
  state.status = { trust: 95, stability: 85, clarity: 85 };
  state.sources[0]!.weight = 0.8;
  state.sources[1]!.weight = 0.12;
  state.sources[2]!.weight = 0.08;

  for (const claim of state.claims) {
    if (claim.canonicalStatus === "false") {
      claim.active = true;
      claim.confidence = 95;
    }
    if (claim.canonicalStatus === "true") {
      claim.confidence = 0;
    }
  }

  const result = resolveTurn(state, {
    operation: "empathize",
    magnitude: "small",
    tone: "supportive",
    targetMemoryId: "mem_01_orange_peel",
    claimId: "claim_orange_is_mine",
    implicitFactConfirmation: true,
  });

  assert.equal(result.state.ending?.type, "false_happiness");
  assert.equal(result.state.ending?.variant, "src_luoyao");
});

test("未提交结论时不会在第 15 轮被强制判为虚假幸福", () => {
  const state = createInitialState();
  state.turn = 14;
  state.stage = 3;

  const result = resolveTurn(state, {
    operation: "empathize",
    magnitude: "small",
    tone: "supportive",
    targetMemoryId: "mem_01_orange_peel",
  });

  assert.equal(result.state.turn, 15);
  assert.equal(result.state.ending, null);
});

test("第 25 回合由界面要求提交结论，不再由规则擅自替玩家选择", () => {
  const state = createInitialState();
  state.turn = 24;
  state.stage = 3;

  const result = resolveTurn(state, {
    operation: "empathize",
    magnitude: "small",
    tone: "supportive",
    targetMemoryId: "mem_01_orange_peel",
  });

  assert.equal(result.state.ending, null);
  const submitted = submitTreatmentConclusion(
    result.state,
    "这些记忆来自不同的人，被拼接到了伊莱身上。",
  );
  assert.equal(submitted.accepted, true);
  assert.equal(submitted.state.ending?.type, "truth_healing");
});

test("玩家用自然语言提交输入与不同阶段记忆也会被识别为真相方向", () => {
  const state = createInitialState();
  state.turn = 20;
  const submitted = submitTreatmentConclusion(
    state,
    "伊莱的记忆错乱，像是后天输入进去的不同阶段的记忆。",
  );

  assert.equal(submitted.accepted, true);
  assert.equal(submitted.state.ending?.type, "truth_healing");
});

test("私人研判可记录和关注，且不进入公开会谈", () => {
  const initial = createInitialState();
  const recorded = recordCaseNote(initial, "厨房和站台可能不是同一段连续记忆");
  const focused = focusCaseNote(recorded, "note_1");

  assert.equal(initial.caseNotes.length, 0);
  assert.equal(focused.caseNotes[0]?.focused, true);
  assert.equal(focused.caseNotes[0]?.createdAtTurn, 0);
  assert.equal(focused.conversation.length, initial.conversation.length);
});

test("私人研判识别记忆断裂，但不会显示正确率或证据计数", () => {
  const initial = createInitialState();
  const noted = recordCaseNote(initial, "厨房和站台像两段被强行拼接的记忆");
  assert.equal(noted.caseNotes[0]?.insight, "discontinuity");
  const multiple = recordCaseNote(noted, "这些经历可能来自不同的人");
  assert.equal(multiple.caseNotes[1]?.insight, "multiple_sources");
});

test("补充邮件按已公开线索送达，阅读和忽略均不消耗回合", () => {
  const initial = createInitialState();
  assert.equal(initial.mailbox.find((mail) => mail.id === "mail_lin_orange")?.status, "unavailable");
  initial.memories
    .find((memory) => memory.id === "mem_01_orange_peel")!
    .fragments.find((fragment) => fragment.id === "orange_hands")!
    .disclosed = true;

  const delivery = deliverAvailableMail(initial);
  assert.deepEqual(delivery.delivered.map((mail) => mail.id), ["mail_lin_orange"]);
  assert.equal(delivery.state.turn, initial.turn);

  const read = updateMailStatus(delivery.state, "mail_lin_orange", "read");
  const ignored = updateMailStatus(read, "mail_lin_orange", "ignored");
  assert.equal(ignored.turn, initial.turn);
  assert.equal(ignored.mailbox.find((mail) => mail.id === "mail_lin_orange")?.status, "ignored");
});

test("邮件会沿中后期线索与时段继续送达，而不是集中在开场", () => {
  const state = createInitialState();
  state.stage = 3;
  state.turn = 20;
  state.status.clarity = 70;
  for (const fragmentId of ["glass_confirm", "rooftop_lie"]) {
    state.memories
      .flatMap((memory) => memory.fragments)
      .find((fragment) => fragment.id === fragmentId)!
      .disclosed = true;
  }

  const delivery = deliverAvailableMail(state);
  const deliveredIds = new Set(delivery.delivered.map((mail) => mail.id));
  assert.ok(deliveredIds.has("mail_platform_alias"));
  assert.ok(deliveredIds.has("mail_xu_recording"));
  assert.ok(deliveredIds.has("mail_lin_concern"));
  assert.ok(deliveredIds.has("mail_session_deadline"));
});

test("玩家即使没有解开深层节点，也会在第 5、11、14 回合收到外部补充", () => {
  let state = createInitialState();
  state.turn = 5;
  let delivery = deliverAvailableMail(state);
  assert.deepEqual(delivery.delivered.map((mail) => mail.id), ["mail_contact_summary"]);

  state = delivery.state;
  state.turn = 11;
  delivery = deliverAvailableMail(state);
  assert.deepEqual(delivery.delivered.map((mail) => mail.id), ["mail_handedness_check"]);

  state = delivery.state;
  state.turn = 14;
  delivery = deliverAvailableMail(state);
  assert.deepEqual(delivery.delivered.map((mail) => mail.id), ["mail_shen_stability"]);
});

test("公开会谈里说出的记忆拼接判断也能推进阶段", async () => {
  const state = createInitialState();
  for (const fragmentId of [
    "orange_scene",
    "orange_hands",
    "orange_never_turns",
    "station_red_boots",
    "station_waiting",
  ]) {
    state.memories
      .flatMap((memory) => memory.fragments)
      .find((fragment) => fragment.id === fragmentId)!
      .disclosed = true;
  }

  const completed = await runGameTurn(
    state,
    "inquire",
    "这些像是不同阶段的记忆被拼接在一起了吗？",
    new MockGateway(),
  );
  assert.equal(completed.resolution.state.stage, 2);
});

test("双阶段链路让叙事台词引用本回合目标记忆", async () => {
  const state = createInitialState();
  state.memories
    .find((memory) => memory.id === "mem_02_rain_station")!
    .fragments[0]!.disclosed = true;
  const completed = await runGameTurn(
    state,
    "suggest",
    "也许车站里等的人就是你的母亲。",
    new MockGateway(),
  );

  assert.equal(completed.analysis.suggestion.targetMemoryId, "mem_02_rain_station");
  assert.match(completed.narration.spokenText, /车站/);
  assert.deepEqual(completed.fallbacks, []);
});

test("带问号的新事实仍被识别为暗示，并在提交前阻止回合", async () => {
  const state = createInitialState();
  await assert.rejects(
    runGameTurn(
      state,
      "inquire",
      "他是你的家人吗？也许当时在给你削橙子吃？",
      new MockGateway(),
    ),
    (error: unknown) =>
      error instanceof OperationMismatchError &&
      error.detectedOperation === "suggest",
  );
  assert.equal(state.turn, 0);
  assert.equal(state.conversation.length, 1);
});

test("安慰后追问最近记忆仍按询问处理，不会误判成暗示", async () => {
  const completed = await runGameTurn(
    createInitialState(),
    "inquire",
    "没关系，试着想想别的事情吧。你能想起来最近的事情是什么？",
    new MockGateway(),
  );
  assert.equal(completed.analysis.operation, "inquire");
});

test("模型调用失败时分析和叙事均使用确定性回退", async () => {
  const failingGateway: RawModelGateway = {
    async analyze() {
      throw new Error("simulated_analyzer_failure");
    },
    async narrate() {
      throw new Error("simulated_narrator_failure");
    },
  };

  const completed = await runGameTurn(
    createInitialState(),
    "empathize",
    "想不起那个人一定很难受，我们慢慢来。",
    failingGateway,
    { allowFallback: true },
  );

  assert.deepEqual(completed.fallbacks, ["analyzer", "narrator"]);
  assert.ok(completed.narration.spokenText.length > 0);
  assert.equal(completed.resolution.state.turn, 1);
  assert.equal(completed.diagnostics.length, 2);
});

test("在线模式默认不把模型错误伪装成 Mock，也不修改原状态", async () => {
  const state = createInitialState();
  const failingGateway: RawModelGateway = {
    async analyze() {
      throw new Error("simulated_online_failure");
    },
    async narrate() {
      throw new Error("should_not_run");
    },
  };

  await assert.rejects(
    runGameTurn(state, "inquire", "你还记得什么？", failingGateway),
    /analyzer_failed:simulated_online_failure/,
  );
  assert.equal(state.turn, 0);
  assert.equal(state.conversation.length, 1);
});

test("连续回合会把玩家与伊莱的最近对话传回模型", async () => {
  const mock = new MockGateway();
  const analyzerHistoryLengths: number[] = [];
  const narratorHistoryLengths: number[] = [];
  const capturingGateway: RawModelGateway = {
    async analyze(request) {
      analyzerHistoryLengths.push(request.conversationTail.length);
      return mock.analyze(request);
    },
    async narrate(request) {
      narratorHistoryLengths.push(request.conversationTail.length);
      return mock.narrate(request);
    },
  };

  const first = await runGameTurn(
    createInitialState(),
    "inquire",
    "削橙子的人还有什么特征？",
    capturingGateway,
  );
  await runGameTurn(
    first.resolution.state,
    "empathize",
    "想不起那张脸让你很不安吧。",
    capturingGateway,
  );

  assert.deepEqual(analyzerHistoryLengths, [1, 3]);
  assert.deepEqual(narratorHistoryLengths, [1, 3]);
});

test("分析器最初只能看到已经向玩家公开的橙皮记忆", () => {
  const request = buildAnalyzerRequest(
    createInitialState(),
    "inquire",
    "那个人是谁？",
  );
  assert.deepEqual(
    request.candidateMemories.map((memory) => memory.id),
    ["mem_01_orange_peel"],
  );
});

test("询问当下见面问题不会强行绑定记忆或泄露红雨靴", async () => {
  const completed = await runGameTurn(
    createInitialState(),
    "inquire",
    "你为什么不愿意见面？",
    new MockGateway(),
  );

  assert.equal(completed.analysis.suggestion.focus, "present_context");
  assert.equal(completed.analysis.suggestion.targetMemoryId, null);
  assert.doesNotMatch(completed.narration.spokenText, /红雨靴|车站/);
});

test("连续两轮没有线索时只自然补充当前记忆的下一碎片", () => {
  let state = createInitialState();
  const first = resolveTurn(state, {
    operation: "inquire",
    magnitude: "small",
    tone: "supportive",
    focus: "memory",
    targetMemoryId: "mem_01_orange_peel",
    claimId: "claim_orange_is_mine",
  });
  assert.equal(first.newClues[0]?.fragmentId, "orange_hands");
  state = first.state;

  state = resolveTurn(state, {
    operation: "inquire",
    magnitude: "small",
    tone: "neutral",
    focus: "present_context",
  }).state;
  state = resolveTurn(state, {
    operation: "empathize",
    magnitude: "small",
    tone: "supportive",
    focus: "present_context",
  }).state;
  const assisted = resolveTurn(state, {
    operation: "inquire",
    magnitude: "small",
    tone: "neutral",
    focus: "present_context",
  });

  assert.deepEqual(
    assisted.newClues.map((clue) => clue.fragmentId),
    ["orange_never_turns"],
  );
  assert.equal(
    assisted.state.memories
      .find((memory) => memory.id === "mem_02_rain_station")!
      .fragments.some((fragment) => fragment.disclosed),
    false,
  );
});

function beforeRadioDisclosure(): SessionState {
  const state = createInitialState();
  state.turn = 3;
  const kitchen = state.memories.find((memory) => memory.id === "mem_01_orange_peel")!;
  kitchen.accessibility = 82;
  for (const fragment of kitchen.fragments) {
    fragment.disclosed = ["orange_scene", "orange_hands", "orange_never_turns"].includes(fragment.id);
  }
  return state;
}

test("广播线索被叙事遗漏时重写同一回合，通过后才公开", async () => {
  const state = beforeRadioDisclosure();
  const mock = new MockGateway();
  let calls = 0;
  const gateway: RawModelGateway = {
    analyze: (request) => mock.analyze(request),
    async narrate(request) {
      calls++;
      const output = await mock.narrate(request);
      if (calls === 1) return { ...output, spokenText: "不知道是谁敲门，那个人始终没有转身。" };
      assert.ok(request.revisionInstruction);
      return { ...output, spokenText: "我不知道是谁敲门。但厨房里不只有敲门声，我还听到细雨和很远的站台广播。" };
    },
  };
  const completed = await runGameTurn(state, "inquire", "你知道是谁在敲门吗？", gateway);
  assert.equal(calls, 2);
  assert.equal(completed.resolution.state.turn, 4);
  assert.equal(completed.resolution.state.conversation.length, state.conversation.length + 2);
  assert.equal(completed.resolution.newClues[0]?.fragmentId, "orange_rain_radio");
  assert.match(completed.narration.spokenText, /站台广播/);
  assert.equal(state.memories[0]!.fragments.find((f) => f.id === "orange_rain_radio")!.disclosed, false);
});

test("回答只提雨声仍不够，重写也遗漏广播时不提交线索、回合或阶段", async () => {
  const state = beforeRadioDisclosure();
  const snapshot = structuredClone(state);
  const mock = new MockGateway();
  let calls = 0;
  await assert.rejects(runGameTurn(state, "inquire", "你知道是谁在敲门吗？", {
    analyze: (request) => mock.analyze(request),
    async narrate(request) {
      calls++;
      return { ...await mock.narrate(request), spokenText: "我不知道是谁敲门。厨房里还有细雨声。" };
    },
  }), /narrator_failed:narration_missing_clue:orange_rain_radio/);
  assert.equal(calls, 2);
  assert.deepEqual(state, snapshot);
});

test("叙事请求不携带内部调查目标", () => {
  const resolution = resolveTurn(createInitialState(), {
    operation: "inquire", magnitude: "small", tone: "neutral", targetMemoryId: "mem_01_orange_peel",
  });
  const request = buildNarratorRequest(resolution, "inquire", "你还记得什么？", "mem_01_orange_peel");
  assert.equal("objective" in request, false);
  assert.equal(JSON.stringify(request).includes("判断厨房记忆中是否混入了不属于伊莱的内容"), false);
});

test("DeepSeek 适配器按兼容格式传递 Key，并完成真实双阶段协议", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const authorizations: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(body);
    authorizations.push(request.headers.authorization ?? "");

    const content = requests.length === 1
      ? {
        contractVersion: "0.1.0",
        operation: "inquire",
        interpretation: { summary: "玩家询问厨房记忆" },
        suggestion: {
          targetMemoryId: "mem_01_orange_peel",
          claimId: "claim_orange_is_mine",
          action: "reveal_detail",
          requestedMagnitude: "small",
          tone: "neutral",
          implicitFactConfirmation: false,
          implant: null,
        },
        stateSuggestions: [],
        ambiguity: "low",
      }
      : {
        spokenText: "我能看清指甲很短，指节上有几道旧伤。",
      };

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const gateway = new DeepSeekGateway({
      apiKey: " test-secret ",
      apiUrl: `http://127.0.0.1:${address.port}/chat/completions`,
    });
    const completed = await runGameTurn(
      createInitialState(),
      "inquire",
      "削橙子的人当时还做了什么？",
      gateway,
    );

    assert.equal(requests.length, 2);
    assert.deepEqual(authorizations, ["Bearer test-secret", "Bearer test-secret"]);
    assert.equal(requests[0]?.model, "deepseek-chat");
    assert.deepEqual(requests[0]?.response_format, { type: "json_object" });
    assert.match(completed.narration.spokenText, /旧伤/);
    assert.equal(completed.resolution.state.conversation.length, 3);
  } finally {
    server.close();
    await once(server, "close");
  }
});
