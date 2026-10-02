import type {
  AnalyzerRequest,
  NarratorRequest,
} from "./contracts.ts";
import { disclosureRequirements } from "./disclosure.ts";
import type {
  Operation,
  SessionState,
  TurnResolution,
} from "./types.ts";

const band = (value: number): string =>
  value < 30 ? "low" : value < 70 ? "medium" : "high";

export function buildAnalyzerRequest(
  state: SessionState,
  operation: Operation,
  playerText: string,
): AnalyzerRequest {
  const candidateMemories = state.memories
    .filter((memory) => memory.fragments.some((fragment) => fragment.disclosed))
    .map((memory) => ({
      id: memory.id,
      summary: memory.summary,
      accessibilityBand: band(memory.accessibility),
      claims: state.claims
        .filter((claim) => claim.memoryId === memory.id)
        .map((claim) => ({
          id: claim.id,
          label: claim.label,
          confidenceBand: band(claim.confidence),
          active: claim.active,
        })),
    }));

  return {
    contractVersion: "0.1.0",
    turn: state.turn + 1,
    stage: state.stage,
    selectedOperation: operation,
    playerText,
    conversationTail: state.conversation.slice(-8).map(({ role, text }) => ({
      role,
      text,
    })),
    visibleStateBands: {
      trust: band(state.status.trust),
      stability: band(state.status.stability),
      clarity: band(state.status.clarity),
    },
    candidateMemories,
  };
}

export function buildNarratorRequest(
  resolution: TurnResolution,
  operation: Operation,
  playerText: string,
  targetMemoryId: string | null,
): NarratorRequest {
  const state = resolution.state;
  const targetMemory = state.memories.find((memory) => memory.id === targetMemoryId);
  const sourceMap = new Map(state.sources.map((source) => [source.id, source.weight]));
  const allowedRevelations: string[] = [];
  if (state.stage >= 2) allowedRevelations.push("伊莱可以注意到记忆之间存在接缝");
  if (
    state.stage === 3 &&
    state.claims.some((claim) =>
      claim.id === "claim_three_answers_was_calibration" &&
      claim.active && claim.confidence >= 50
    )
  ) {
    allowedRevelations.push("伊莱可以怀疑自己曾接受某种人格测试，但不能确认自己是 AI");
  }

  return {
    contractVersion: "0.1.0",
    turn: state.turn,
    stage: state.stage,
    player: { operation, text: playerText },
    conversationTail: state.conversation.slice(-8).map(({ role, text }) => ({
      role,
      text,
    })),
    presentContextFacts: [
      "伊莱目前只接受文字交流，认为这样可以在回答前停下来整理情绪。",
      "这次治疗由三位自称伊莱朋友的人安排，目前没有约定线下会面。",
      "伊莱可以坦率表达尚未准备好见面，但不应声称玩家会变成记忆里的人。",
    ],
    stateBands: {
      trust: band(state.status.trust),
      stability: band(state.status.stability),
      clarity: band(state.status.clarity),
    },
    styleWeights: {
      relational: band((sourceMap.get("src_luoyao") ?? 0) * 100),
      truthSeeking: band((sourceMap.get("src_zhouheng") ?? 0) * 100),
      adaptive: band((sourceMap.get("src_sumian") ?? 0) * 100),
    },
    subjectiveMemories: state.memories
      .filter((memory) => memory.fragments.some((fragment) => fragment.disclosed))
      .map((memory) => ({
        id: memory.id,
        summary: memory.summary,
        disclosedFragments: memory.fragments
          .filter((fragment) => fragment.disclosed)
          .map((fragment) => fragment.text),
        activeClaims: state.claims
          .filter((claim) => claim.memoryId === memory.id && claim.active)
          .map((claim) => ({
            label: claim.label,
            confidenceBand: band(claim.confidence),
          })),
      })),
    resolution: {
      targetMemoryId,
      targetMemorySummary: targetMemory?.summary ?? "当前处境与治疗关系",
      reactionMode: resolution.reactionMode,
      effectSummary: targetMemoryId === null
        ? "玩家问的是当下处境或治疗关系。先直接回答，不要强行转向记忆；只有 newClues 非空时才可自然带出其中一条新碎片。"
        : resolution.reactionMode === "accepted"
        ? "伊莱接受了玩家的解释，相关信念已经增强。"
        : resolution.reactionMode === "partial"
        ? "伊莱只接受了一部分解释，仍然明显犹豫。"
        : resolution.reactionMode === "resisted"
        ? "伊莱没有接受这次解释，并对玩家产生抗拒。"
        : operation === "empathize"
        ? "伊莱感到被理解，情绪稍微稳定。"
        : "追问让记忆细节变得更容易访问，也可能暴露接缝。",
      conflictBand: band(state.hidden.conflictPressure),
      machineLeakLevel: state.mode === "collapse"
        ? "overt"
        : state.status.stability < 40
        ? "subtle"
        : "none",
      newClues: resolution.newClues.map(({ memoryId, fragmentId, text }) => ({
        memoryId, fragmentId, text,
        requiredMentions: disclosureRequirements(fragmentId, text),
      })),
    },
    allowedRevelations,
  };
}
