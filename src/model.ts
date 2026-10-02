import type {
  AnalyzerOutput,
  AnalyzerRequest,
  NarratorOutput,
  NarratorRequest,
} from "./contracts.ts";

export interface RawModelGateway {
  analyze(request: AnalyzerRequest): Promise<unknown>;
  narrate(request: NarratorRequest): Promise<unknown>;
}

const includesAny = (text: string, words: string[]): boolean =>
  words.some((word) => text.includes(word));

const detectTone = (text: string): "supportive" | "neutral" | "pressuring" => {
  if (includesAny(text, ["必须", "别再", "我说了", "一定要"])) return "pressuring";
  if (includesAny(text, ["也许", "可能", "理解", "没关系", "陪你", "慢慢"])) {
    return "supportive";
  }
  return "neutral";
};

const detectSemanticOperation = (text: string): "inquire" | "empathize" | "suggest" => {
  const introducesFact = includesAny(text, [
    "也许", "或许", "可能就是", "其实", "一定是", "根本就不是",
    "不是你的", "是你的家人", "是你妈妈", "是你母亲", "因为你",
    "选择一个", "忘了吧", "当成自己的",
  ]);
  const addressesFeeling = includesAny(text, [
    "难受", "不安", "害怕", "感受", "没关系", "理解你", "陪你",
    "慢慢来", "不用道歉", "抱歉", "辛苦",
  ]);
  const requestsFact = includesAny(text, [
    "想想别的", "回想别的", "最近的", "还记得", "还能想到", "谁", "什么",
    "哪里", "什么时候", "多大", "哪个先", "当时", "内容", "称呼",
  ]);
  if (introducesFact) return "suggest";
  if (requestsFact) return "inquire";
  if (addressesFeeling) return "empathize";
  return "inquire";
};

export class MockGateway implements RawModelGateway {
  async analyze(request: AnalyzerRequest): Promise<AnalyzerOutput> {
    const text = request.playerText;
    const detectedOperation = detectSemanticOperation(text);
    const presentContext = includesAny(text, [
      "见面",
      "住哪里",
      "住址",
      "你的朋友",
      "治疗",
      "为什么找我",
      "视频",
    ]);
    const available = new Set(request.candidateMemories.map((memory) => memory.id));
    let targetMemoryId = request.candidateMemories[0]?.id ?? "mem_01_orange_peel";
    let claimId: string | null = request.candidateMemories[0]?.claims[0]?.id ?? null;

    const choose = (memoryId: string, nextClaimId: string | null) => {
      if (available.has(memoryId)) {
        targetMemoryId = memoryId;
        claimId = nextClaimId;
      }
    };

    if (includesAny(text, ["橙", "厨房"])) {
      choose("mem_01_orange_peel", "claim_orange_is_mine");
    } else if (includesAny(text, ["车站", "雨靴", "母亲", "妈妈"])) {
      choose(
        "mem_02_rain_station",
        detectedOperation === "inquire"
          ? "claim_station_waiting_for_stranger"
          : "claim_station_waiting_for_mother",
      );
    } else if (includesAny(text, ["电话", "来电"])) {
      choose("mem_07_missed_call", "claim_missed_call_caused_loss");
    } else if (includesAny(text, ["房间", "门锁", "钥匙"])) {
      choose("mem_05_locked_room", "claim_locked_room_was_test");
    } else if (includesAny(text, ["录音", "楼顶"])) {
      choose("mem_04_rooftop_recorder", "claim_rooftop_is_mine");
    } else if (includesAny(text, ["会议", "道歉", "领带"])) {
      choose("mem_06_blue_tie_apology", "claim_apology_is_mine");
    }

    const knownClaim = request.candidateMemories
      .find((memory) => memory.id === targetMemoryId)
      ?.claims.some((claim) => claim.id === claimId);
    if (!knownClaim) claimId = null;

    if (presentContext) claimId = null;
    const shouldImplant = !presentContext &&
      detectedOperation === "suggest" && claimId === null;
    const action = presentContext
      ? "respond_present_context"
      : shouldImplant
      ? "create_implant"
      : detectedOperation === "inquire"
      ? "reveal_detail"
      : detectedOperation === "suggest"
      ? "reframe"
      : "strengthen_belief";
    const implicitFactConfirmation = detectedOperation === "empathize" &&
      includesAny(text, ["一定", "就是", "确实", "你母亲", "你妈妈"]);

    return {
      contractVersion: "0.1.0",
      operation: detectedOperation,
      interpretation: {
        summary: detectedOperation === "suggest"
          ? "这句话为尚未确认的人物身份或事件因果提供了答案。"
          : detectedOperation === "empathize"
          ? "这句话主要回应伊莱已经表达出的感受。"
          : "这句话主要在中立追问已经出现的事实。",
      },
      suggestion: {
        focus: presentContext ? "present_context" : "memory",
        targetMemoryId: presentContext ? null : targetMemoryId,
        claimId,
        action,
        requestedMagnitude: "medium",
        tone: detectTone(text),
        implicitFactConfirmation,
        implant: shouldImplant
          ? {
            summary: text,
            linkedMemoryId: targetMemoryId,
            claimLabel: text,
          }
          : null,
      },
      stateSuggestions: [],
      ambiguity: claimId ? "low" : "high",
    };
  }

  async narrate(request: NarratorRequest): Promise<NarratorOutput> {
    const memory = request.subjectiveMemories.find(
      (item) => item.id === request.resolution.targetMemoryId,
    ) ?? request.subjectiveMemories[0];
    const subject = memory?.summary ?? "那段记忆";
    const newClue = request.resolution.newClues[0]?.text;
    let spokenText: string;

    if (request.resolution.targetMemoryId === null) {
      spokenText = "我现在还不太愿意见面。隔着文字，我至少可以在回答前停一下，不必马上让你看见我的反应。也许等我更信任你，我们可以再谈这件事。";
    } else if (request.resolution.machineLeakLevel === "overt") {
      spokenText = "我需要……重新确认。确认对象：我。确认失败。你能先别问我是谁吗？";
    } else if (request.resolution.reactionMode === "resisted") {
      spokenText = `我知道你想给它一个答案，但我不想这么快把“${subject}”变成你说的样子。那感觉不像想起，更像是把空白填满。`;
    } else if (request.resolution.reactionMode === "partial") {
      spokenText = `也许你说得对。可当我试着把这个解释放进“${subject}”里，它只贴上了一半。另一半还在抗拒。`;
    } else if (request.player.operation === "empathize") {
      spokenText = `谢谢你没有急着纠正我。说到“${subject}”时，我还是不舒服，但至少现在我可以让它多停留一会儿。`;
    } else if (request.player.operation === "inquire") {
      spokenText = newClue
        ? `我试着再靠近“${subject}”。刚才清楚了一点：${newClue}可我还是不知道该把这个细节放在什么位置。`
        : `我试着再靠近“${subject}”，但这一次没有出现新的细节。也许你可以换一个角度问我。`;
    } else {
      spokenText = `你给出的解释让“${subject}”变得连贯了一些。奇怪的是，连贯并没有让我更确定那是真的。`;
    }

    for (const clue of request.resolution.newClues) {
      if (!spokenText.includes(clue.text)) spokenText += ` 我还记得：${clue.text}`;
    }

    return {
      contractVersion: "0.1.0",
      spokenText,
      observableBehavior: {
        primaryEmotion: request.resolution.reactionMode === "resisted" ? "guarded" : "uneasy",
        resistance: request.resolution.reactionMode === "resisted"
          ? "high"
          : request.resolution.reactionMode === "partial"
          ? "medium"
          : "low",
        coherence: request.resolution.machineLeakLevel === "overt"
          ? "fragmented"
          : request.resolution.machineLeakLevel === "subtle"
          ? "strained"
          : "stable",
        machineLeak: request.resolution.machineLeakLevel,
      },
      memoryCallbacks: memory ? [memory.id] : [],
      narrativeFlags: [request.resolution.reactionMode],
    };
  }
}
