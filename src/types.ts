export type Operation = "inquire" | "empathize" | "suggest";
export type Magnitude = "small" | "medium" | "large";
export type Tone = "supportive" | "neutral" | "pressuring";
export type CanonicalStatus = "true" | "false" | "ambiguous" | "unverified";
export type SourceId = "src_luoyao" | "src_zhouheng" | "src_sumian";

export interface StatusBars {
  trust: number;
  stability: number;
  clarity: number;
}

export interface HiddenMetrics {
  truthAlignment: number;
  identityDominance: number;
  conflictPressure: number;
}

export interface SourceProfile {
  id: SourceId;
  label: string;
  weight: number;
}

export interface MemoryNode {
  id: string;
  kind: "core" | "implant";
  summary: string;
  accessibility: number;
  strength: number;
  emotionIntensity: number;
  anomaly: boolean;
  fragments: MemoryFragment[];
}

export interface MemoryFragment {
  id: string;
  text: string;
  unlockAtAccessibility: number;
  disclosed: boolean;
  reliability: "grounded" | "unstable" | "player_influenced";
  contaminationOnly?: boolean;
}

export interface MemoryClaim {
  id: string;
  memoryId: string;
  label: string;
  canonicalStatus: CanonicalStatus;
  confidence: number;
  active: boolean;
  origin: "seed" | "discovered" | "player_suggestion" | "player_implanted";
  sourceAffinity: Record<SourceId, number>;
  isCompositeIdentityClaim?: boolean;
}

export interface ConflictEdge {
  leftClaimId: string;
  rightClaimId: string;
  weight: number;
}

export interface DialogueMessage {
  turn: number;
  role: "player" | "eli";
  text: string;
}

export interface CaseNote {
  id: string;
  createdAtTurn: number;
  text: string;
  revisedFromId: string | null;
  focused: boolean;
  insight: "none" | "discontinuity" | "multiple_sources";
}

export interface CaseMail {
  id: string;
  from: string;
  subject: string;
  body: string;
  status: "unavailable" | "unread" | "read" | "ignored";
  deliveredAtTurn: number | null;
}

export interface SessionState {
  turn: number;
  stage: 1 | 2 | 3;
  mode: "normal" | "collapse" | "rupture";
  forcedOperation: Operation | null;
  intervention: {
    lastOperation: Operation | null;
    streak: number;
  };
  rescueUsed: {
    trust: boolean;
    stability: boolean;
  };
  status: StatusBars;
  hidden: HiddenMetrics;
  sources: SourceProfile[];
  memories: MemoryNode[];
  claims: MemoryClaim[];
  conflicts: ConflictEdge[];
  conversation: DialogueMessage[];
  caseNotes: CaseNote[];
  mailbox: CaseMail[];
  progress: {
    objective: string;
    noClueTurns: number;
    lastTargetMemoryId: string | null;
    submittedConclusion: string | null;
  };
  ending: null | {
    type: "truth_healing" | "false_happiness" | "open_question" | "treatment_interrupted";
    quality: "fragile" | "stable";
    variant?: SourceId;
  };
}

export interface ImplantProposal {
  summary: string;
  linkedMemoryId: string;
  claimLabel: string;
}

export interface TurnIntent {
  operation: Operation;
  magnitude: Magnitude;
  tone: Tone;
  focus?: "memory" | "present_context";
  targetMemoryId?: string;
  claimId?: string;
  claimDirection?: "strengthen" | "weaken";
  implicitFactConfirmation?: boolean;
  implant?: ImplantProposal;
}

export interface TurnResolution {
  state: SessionState;
  accepted: boolean;
  partial: boolean;
  acceptanceScore: number | null;
  reactionMode: "accepted" | "partial" | "resisted" | "processed";
  changes: string[];
  errors: string[];
  newClues: Array<{
    memoryId: string;
    fragmentId: string;
    text: string;
  }>;
}
