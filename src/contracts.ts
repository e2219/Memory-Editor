import type {
  Magnitude,
  Operation,
  SessionState,
  Tone,
  TurnIntent,
  TurnResolution,
} from "./types.ts";

export type AnalyzerAction =
  | "reveal_detail"
  | "strengthen_belief"
  | "weaken_belief"
  | "reframe"
  | "create_implant"
  | "respond_present_context";

export interface AnalyzerRequest {
  contractVersion: "0.1.0";
  turn: number;
  stage: 1 | 2 | 3;
  selectedOperation: Operation;
  playerText: string;
  conversationTail: Array<{
    role: "player" | "eli";
    text: string;
  }>;
  visibleStateBands: Record<"trust" | "stability" | "clarity", string>;
  candidateMemories: Array<{
    id: string;
    summary: string;
    accessibilityBand: string;
    claims: Array<{
      id: string;
      label: string;
      confidenceBand: string;
      active: boolean;
    }>;
  }>;
}

export interface AnalyzerOutput {
  contractVersion: "0.1.0";
  operation: Operation;
  interpretation: {
    summary: string;
  };
  suggestion: {
    focus: "memory" | "present_context";
    targetMemoryId: string | null;
    claimId: string | null;
    action: AnalyzerAction;
    requestedMagnitude: Magnitude;
    tone: Tone;
    implicitFactConfirmation: boolean;
    implant: null | {
      summary: string;
      linkedMemoryId: string;
      claimLabel: string;
    };
  };
  stateSuggestions: Array<{
    field: "trust" | "stability" | "clarity";
    direction: "increase" | "decrease" | "unchanged";
    requestedMagnitude: Magnitude;
  }>;
  ambiguity: "low" | "medium" | "high";
}

export interface NarratorRequest {
  contractVersion: "0.1.0";
  turn: number;
  stage: 1 | 2 | 3;
  revisionInstruction?: string;
  player: {
    operation: Operation;
    text: string;
  };
  conversationTail: Array<{
    role: "player" | "eli";
    text: string;
  }>;
  presentContextFacts: string[];
  stateBands: Record<"trust" | "stability" | "clarity", string>;
  styleWeights: Record<"relational" | "truthSeeking" | "adaptive", string>;
  subjectiveMemories: Array<{
    id: string;
    summary: string;
    disclosedFragments: string[];
    activeClaims: Array<{
      label: string;
      confidenceBand: string;
    }>;
  }>;
  resolution: {
    targetMemoryId: string | null;
    targetMemorySummary: string;
    reactionMode: TurnResolution["reactionMode"];
    effectSummary: string;
    conflictBand: string;
    machineLeakLevel: "none" | "subtle" | "overt";
    newClues: Array<{
      memoryId: string;
      fragmentId: string;
      text: string;
      requiredMentions: string[][];
    }>;
  };
  allowedRevelations: string[];
}

export interface NarratorOutput {
  contractVersion: "0.1.0";
  spokenText: string;
  observableBehavior: {
    primaryEmotion: string;
    resistance: "none" | "low" | "medium" | "high";
    coherence: "stable" | "strained" | "fragmented";
    machineLeak: "none" | "subtle" | "overt";
  };
  memoryCallbacks: string[];
  narrativeFlags: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOneOf = <T extends string>(value: unknown, values: readonly T[]): value is T =>
  typeof value === "string" && values.includes(value as T);

export function validateAnalyzerOutput(
  raw: unknown,
  request: AnalyzerRequest,
  state: SessionState,
): AnalyzerOutput {
  if (!isObject(raw) || raw.contractVersion !== "0.1.0") {
    throw new Error("invalid_analyzer_contract");
  }
  const operationValues = ["inquire", "empathize", "suggest"] as const;
  if (!isOneOf(raw.operation, operationValues)) throw new Error("invalid_operation");
  const interpretation = isObject(raw.interpretation) &&
      typeof raw.interpretation.summary === "string"
    ? { summary: raw.interpretation.summary }
    : { summary: "玩家正在影响目标记忆。" };
  if (!isObject(raw.suggestion)) throw new Error("invalid_analyzer_suggestion");

  const focus = raw.suggestion.focus === "present_context"
    ? "present_context"
    : "memory";
  const targetMemoryId = focus === "present_context"
    ? null
    : raw.suggestion.targetMemoryId;
  const candidate = request.candidateMemories.find((memory) => memory.id === targetMemoryId);
  if (focus === "memory" && !candidate) throw new Error("analyzer_target_not_visible");
  if (focus === "present_context" && targetMemoryId !== null) {
    throw new Error("present_context_must_not_target_memory");
  }

  const actionValues = [
    "reveal_detail",
    "strengthen_belief",
    "weaken_belief",
    "reframe",
    "create_implant",
    "respond_present_context",
  ] as const;
  const magnitudeValues = ["small", "medium", "large"] as const;
  const toneValues = ["supportive", "neutral", "pressuring"] as const;
  if (!isOneOf(raw.suggestion.action, actionValues)) throw new Error("invalid_action");
  if (!isOneOf(raw.suggestion.requestedMagnitude, magnitudeValues)) {
    throw new Error("invalid_magnitude");
  }
  const tone = isOneOf(raw.suggestion.tone, toneValues)
    ? raw.suggestion.tone
    : "neutral";
  const implicitFactConfirmation =
    typeof raw.suggestion.implicitFactConfirmation === "boolean"
      ? raw.suggestion.implicitFactConfirmation
      : false;

  const claimId = raw.suggestion.claimId ?? null;
  if (claimId !== null) {
    if (typeof claimId !== "string") throw new Error("invalid_claim_id");
    const claim = state.claims.find((item) => item.id === claimId);
    if (focus !== "memory" || !claim || claim.memoryId !== targetMemoryId) {
      throw new Error("claim_memory_mismatch");
    }
  }

  const implant = raw.suggestion.implant;
  if (raw.suggestion.action === "create_implant") {
    if (raw.operation !== "suggest") throw new Error("implant_requires_suggest");
    if (
      !isObject(implant) ||
      typeof implant.summary !== "string" ||
      typeof implant.claimLabel !== "string" ||
      implant.linkedMemoryId !== targetMemoryId
    ) {
      throw new Error("invalid_implant");
    }
  } else if (implant !== null && implant !== undefined) {
    throw new Error("unexpected_implant");
  }

  const stateSuggestions = Array.isArray(raw.stateSuggestions)
    ? raw.stateSuggestions
    : [];
  const ambiguity = isOneOf(raw.ambiguity, ["low", "medium", "high"] as const)
    ? raw.ambiguity
    : "medium";

  return {
    contractVersion: "0.1.0",
    operation: raw.operation,
    interpretation,
    suggestion: {
      targetMemoryId,
      focus,
      claimId: claimId as string | null,
      action: raw.suggestion.action,
      requestedMagnitude: raw.suggestion.requestedMagnitude,
      tone,
      implicitFactConfirmation,
      implant: raw.suggestion.action === "create_implant"
        ? implant as AnalyzerOutput["suggestion"]["implant"]
        : null,
    },
    stateSuggestions: stateSuggestions as AnalyzerOutput["stateSuggestions"],
    ambiguity,
  };
}

export function analyzerOutputToIntent(output: AnalyzerOutput): TurnIntent {
  return {
    operation: output.operation,
    magnitude: output.suggestion.requestedMagnitude,
    tone: output.suggestion.tone,
    focus: output.suggestion.focus,
    ...(output.suggestion.targetMemoryId
      ? { targetMemoryId: output.suggestion.targetMemoryId }
      : {}),
    ...(output.suggestion.claimId ? { claimId: output.suggestion.claimId } : {}),
    ...(output.suggestion.action === "weaken_belief"
      ? { claimDirection: "weaken" as const }
      : { claimDirection: "strengthen" as const }),
    implicitFactConfirmation: output.suggestion.implicitFactConfirmation,
    ...(output.suggestion.implant ? { implant: output.suggestion.implant } : {}),
  };
}

export function validateNarratorOutput(raw: unknown): NarratorOutput {
  if (
    !isObject(raw) ||
    (raw.contractVersion !== undefined && raw.contractVersion !== "0.1.0")
  ) {
    throw new Error("invalid_narrator_contract");
  }
  if (
    typeof raw.spokenText !== "string" ||
    raw.spokenText.trim().length === 0 ||
    raw.spokenText.length > 2000
  ) {
    throw new Error("invalid_spoken_text");
  }
  const behavior = isObject(raw.observableBehavior)
    ? raw.observableBehavior
    : {};
  const resistance = isOneOf(
      behavior.resistance,
      ["none", "low", "medium", "high"] as const,
    )
    ? behavior.resistance
    : "low";
  const coherence = isOneOf(
      behavior.coherence,
      ["stable", "strained", "fragmented"] as const,
    )
    ? behavior.coherence
    : "stable";
  const machineLeak = isOneOf(
      behavior.machineLeak,
      ["none", "subtle", "overt"] as const,
    )
    ? behavior.machineLeak
    : "none";

  return {
    contractVersion: "0.1.0",
    spokenText: raw.spokenText.trim(),
    observableBehavior: {
      primaryEmotion: typeof behavior.primaryEmotion === "string"
        ? behavior.primaryEmotion
        : "uncertain",
      resistance,
      coherence,
      machineLeak,
    },
    memoryCallbacks: Array.isArray(raw.memoryCallbacks)
      ? raw.memoryCallbacks.filter((item): item is string => typeof item === "string")
      : [],
    narrativeFlags: Array.isArray(raw.narrativeFlags)
      ? raw.narrativeFlags.filter((item): item is string => typeof item === "string")
      : [],
  };
}
