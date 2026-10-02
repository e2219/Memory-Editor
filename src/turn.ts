import {
  analyzerOutputToIntent,
  validateAnalyzerOutput,
  validateNarratorOutput,
} from "./contracts.ts";
import { refreshCaseProgress } from "./engine.ts";
import { validateDisclosure } from "./disclosure.ts";
import type {
  AnalyzerOutput,
  NarratorOutput,
} from "./contracts.ts";
import {
  buildAnalyzerRequest,
  buildNarratorRequest,
} from "./context.ts";
import { resolveTurn } from "./engine.ts";
import { MockGateway } from "./model.ts";
import type { RawModelGateway } from "./model.ts";
import type {
  Operation,
  SessionState,
  TurnResolution,
} from "./types.ts";

export interface CompletedTurn {
  analysis: AnalyzerOutput;
  resolution: TurnResolution;
  narration: NarratorOutput;
  fallbacks: Array<"analyzer" | "narrator">;
  diagnostics: string[];
}

export interface RunTurnOptions {
  allowFallback?: boolean;
  preAnalyzed?: AnalyzerOutput;
}

export class ModelStageError extends Error {
  readonly stage: "analyzer" | "narrator";

  constructor(stage: "analyzer" | "narrator", cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${stage}_failed:${detail}`, { cause });
    this.name = "ModelStageError";
    this.stage = stage;
  }
}

export class OperationMismatchError extends Error {
  readonly selectedOperation: Operation;
  readonly detectedOperation: Operation;
  readonly explanation: string;
  readonly analysis: AnalyzerOutput;

  constructor(
    selected: Operation,
    detected: Operation,
    explanation: string,
    analysis: AnalyzerOutput,
  ) {
    super(`operation_mismatch:${selected}:${detected}`);
    this.name = "OperationMismatchError";
    this.selectedOperation = selected;
    this.detectedOperation = detected;
    this.explanation = explanation;
    this.analysis = analysis;
  }
}

export async function runGameTurn(
  state: SessionState,
  operation: Operation,
  playerText: string,
  gateway: RawModelGateway,
  options: RunTurnOptions = {},
): Promise<CompletedTurn> {
  const fallback = new MockGateway();
  const fallbacks: CompletedTurn["fallbacks"] = [];
  const diagnostics: string[] = [];
  const analyzerRequest = buildAnalyzerRequest(state, operation, playerText);
  let analysis: AnalyzerOutput;

  if (options.preAnalyzed) {
    analysis = options.preAnalyzed;
  } else {
    try {
      analysis = validateAnalyzerOutput(
        await gateway.analyze(analyzerRequest),
        analyzerRequest,
        state,
      );
    } catch (error) {
      diagnostics.push(new ModelStageError("analyzer", error).message);
      if (!options.allowFallback) throw new ModelStageError("analyzer", error);
      fallbacks.push("analyzer");
      analysis = validateAnalyzerOutput(
        await fallback.analyze(analyzerRequest),
        analyzerRequest,
        state,
      );
    }
  }

  if (analysis.operation !== operation) {
    throw new OperationMismatchError(
      operation,
      analysis.operation,
      analysis.interpretation.summary,
      analysis,
    );
  }

  const resolution = resolveTurn(state, analyzerOutputToIntent(analysis));
  const narratorRequest = buildNarratorRequest(
    resolution,
    operation,
    playerText,
    analysis.suggestion.targetMemoryId,
  );
  let narration: NarratorOutput;

  try {
    narration = validateNarratorOutput(await gateway.narrate(narratorRequest));
    try {
      validateDisclosure(narration, narratorRequest);
    } catch {
      // Re-render the same draft; never resolve the rules or spend a turn twice.
      diagnostics.push("narration_disclosure_retry");
      narration = validateNarratorOutput(await gateway.narrate({
        ...narratorRequest,
        revisionInstruction: "上一版回答遗漏了获准公开的新线索。请重新自然回答玩家，完整表达每条 newClues.text 的事实，spokenText 必须包含 requiredMentions 每组至少一个词。不要提及重写、校验或系统。",
      }));
      validateDisclosure(narration, narratorRequest);
    }
  } catch (error) {
    diagnostics.push(new ModelStageError("narrator", error).message);
    if (!options.allowFallback) throw new ModelStageError("narrator", error);
    fallbacks.push("narrator");
    narration = validateNarratorOutput(await fallback.narrate(narratorRequest));
    validateDisclosure(narration, narratorRequest);
  }

  resolution.state.conversation.push(
    { turn: resolution.state.turn, role: "player", text: playerText },
    { turn: resolution.state.turn, role: "eli", text: narration.spokenText },
  );

  // 玩家可能在公开对话里直接说出“记忆存在接缝/来自多人”。这同样是有效研判，
  // 不应强迫玩家再用一次隐藏命令复述自己的发现。
  resolution.state = refreshCaseProgress(resolution.state).state;

  return { analysis, resolution, narration, fallbacks, diagnostics };
}
