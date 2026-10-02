import type {
  Magnitude,
  MemoryClaim,
  MemoryNode,
  Operation,
  SessionState,
  SourceId,
  TurnIntent,
  TurnResolution,
} from "./types.ts";
import { classifyCaseInsight } from "./casework.ts";

const MAGNITUDE_POINTS: Record<Magnitude, number> = {
  small: 4,
  medium: 8,
  large: 12,
};

const OPERATION_SOURCE_FACTOR: Record<Operation, number> = {
  inquire: 0.5,
  empathize: 0.7,
  suggest: 1,
};

const SOURCE_IDS: SourceId[] = [
  "src_luoyao",
  "src_zhouheng",
  "src_sumian",
];

const clamp = (value: number, min = 0, max = 100): number =>
  Math.min(max, Math.max(min, value));

const round = (value: number): number => Math.round(value);

const getMemory = (state: SessionState, id?: string) =>
  state.memories.find((memory) => memory.id === id);

const getClaim = (state: SessionState, id?: string) =>
  id ? state.claims.find((claim) => claim.id === id) : undefined;

export function calculateConflictPressure(state: SessionState): number {
  let total = 0;

  for (const edge of state.conflicts) {
    const left = getClaim(state, edge.leftClaimId);
    const right = getClaim(state, edge.rightClaimId);
    if (!left?.active || !right?.active) continue;

    const leftMemory = getMemory(state, left.memoryId);
    const rightMemory = getMemory(state, right.memoryId);
    if (!leftMemory || !rightMemory) continue;

    const confidence = Math.min(left.confidence, right.confidence) / 100;
    const accessibility =
      (leftMemory.accessibility + rightMemory.accessibility) / 200;
    total += edge.weight * confidence * accessibility * 100;
  }

  return clamp(round(total));
}

export function calculateTruthAlignment(state: SessionState): number {
  const active = state.claims.filter(
    (claim) => claim.active && claim.canonicalStatus !== "ambiguous" &&
      claim.canonicalStatus !== "unverified",
  );
  if (active.length === 0) return 50;

  const signed = active.reduce((sum, claim) => {
    const direction = claim.canonicalStatus === "true" ? 1 : -1;
    return sum + direction * claim.confidence;
  }, 0);

  return clamp(round(50 + signed / (active.length * 2)));
}

function calculateIdentityDominance(state: SessionState): number {
  return round(Math.max(...state.sources.map((source) => source.weight)) * 100);
}

function calculateContradictionRisk(
  state: SessionState,
  claim: MemoryClaim,
): number {
  const risks = state.conflicts.flatMap((edge) => {
    const otherId = edge.leftClaimId === claim.id
      ? edge.rightClaimId
      : edge.rightClaimId === claim.id
      ? edge.leftClaimId
      : null;
    if (!otherId) return [];
    const other = getClaim(state, otherId);
    if (!other?.active) return [];
    return [edge.weight * other.confidence];
  });

  return risks.length === 0 ? 0 : clamp(round(Math.max(...risks)));
}

function calculateSourceAffinity(
  state: SessionState,
  claim: MemoryClaim,
): number {
  return clamp(round(state.sources.reduce((sum, source) => {
    return sum + source.weight * claim.sourceAffinity[source.id] * 100;
  }, 0)));
}

function calculateSuggestionAcceptance(
  state: SessionState,
  claim: MemoryClaim,
): number {
  const semanticFit = claim.active ? claim.confidence : 50;
  const sourceAffinity = calculateSourceAffinity(state, claim);
  const contradictionRisk = calculateContradictionRisk(state, claim);

  return clamp(round(
    0.35 * state.status.trust +
      0.15 * state.status.stability +
      0.2 * semanticFit +
      0.15 * sourceAffinity -
      0.3 * contradictionRisk +
      0.15 * (100 - state.status.clarity) -
      (state.intervention.streak >= 3 ? 15 : 0),
  ));
}

function applySourceDrift(
  state: SessionState,
  claim: MemoryClaim,
  operation: Operation,
  points: number,
): void {
  const totalDelta = Math.min(
    0.05,
    (points / 240) * OPERATION_SOURCE_FACTOR[operation],
  );

  for (const source of state.sources) {
    source.weight += totalDelta * claim.sourceAffinity[source.id];
  }

  const total = state.sources.reduce((sum, source) => sum + source.weight, 0);
  for (const source of state.sources) {
    source.weight = source.weight / total;
  }
}

function updateDerivedMetrics(state: SessionState): void {
  state.hidden.conflictPressure = calculateConflictPressure(state);
  state.hidden.truthAlignment = calculateTruthAlignment(state);
  state.hidden.identityDominance = calculateIdentityDominance(state);
}

function applyConflictConsequences(
  state: SessionState,
  previousConflict: number,
): void {
  const increase = Math.max(0, state.hidden.conflictPressure - previousConflict);
  if (increase > 0) {
    state.status.stability = clamp(state.status.stability - Math.max(1, round(increase * 0.3)));
  }
}

function prepareImplant(
  state: SessionState,
  intent: TurnIntent,
  points: number,
  errors: string[],
): { claim: MemoryClaim; memory: MemoryNode; linkedClaimId?: string } | undefined {
  if (!intent.implant) return undefined;
  const implants = state.memories.filter((memory) => memory.kind === "implant");
  if (implants.length >= 2) {
    errors.push("implant_limit_reached");
    return undefined;
  }
  if (!getMemory(state, intent.implant.linkedMemoryId)) {
    errors.push("invalid_linked_memory");
    return undefined;
  }

  const linkedClaim = state.claims.find(
    (claim) => claim.memoryId === intent.implant?.linkedMemoryId && claim.active,
  );
  const sourceAffinity = linkedClaim?.sourceAffinity ?? {
    src_luoyao: 0.34,
    src_zhouheng: 0.33,
    src_sumian: 0.33,
  };
  const suffix = implants.length + 1;
  const memoryId = `mem_implant_${suffix}`;
  const claimId = `claim_implant_${suffix}`;

  const memory: MemoryNode = {
    id: memoryId,
    kind: "implant",
    summary: intent.implant.summary,
    accessibility: 60,
    strength: points,
    emotionIntensity: 40,
    anomaly: false,
    fragments: [
      {
        id: `${memoryId}_fragment`,
        text: intent.implant.summary,
        unlockAtAccessibility: 0,
        disclosed: true,
        reliability: "player_influenced",
      },
    ],
  };
  const claim: MemoryClaim = {
    id: claimId,
    memoryId,
    label: intent.implant.claimLabel,
    canonicalStatus: "unverified",
    confidence: points,
    active: true,
    origin: "player_implanted",
    sourceAffinity: { ...sourceAffinity },
  };
  return { claim, memory, linkedClaimId: linkedClaim?.id };
}

function updateStage(state: SessionState): void {
  const disclosed = state.memories.filter((memory) =>
    memory.fragments.some((fragment) => fragment.disclosed && fragment.reliability === "grounded")
  ).length;
  const disclosedClues = state.memories.reduce(
    (sum, memory) =>
      sum + memory.fragments.filter((fragment) =>
        fragment.disclosed && fragment.reliability === "grounded"
      ).length,
    0,
  );
  const spokenInsights = state.conversation
    .filter((message) => message.role === "player")
    .map((message) => classifyCaseInsight(message.text));
  const insights = [...state.caseNotes.map((note) => note.insight), ...spokenInsights];
  const hasDiscontinuityInsight = insights.some((insight) =>
    insight === "discontinuity" || insight === "multiple_sources"
  );
  const hasMultipleSourcesInsight = insights.some((insight) => insight === "multiple_sources");

  if (
    state.stage === 1 &&
    disclosed >= 2 &&
    disclosedClues >= 5 &&
    hasDiscontinuityInsight
  ) {
    state.stage = 2;
    state.progress.objective = "找出不同记忆之间不自然的接缝";
    return;
  }
  if (
    state.stage === 2 &&
    disclosed >= 2 &&
    disclosedClues >= 7 &&
    hasMultipleSourcesInsight
  ) {
    state.stage = 3;
    state.progress.objective = "帮助伊莱决定自己究竟是谁";
  }
}

export function refreshCaseProgress(
  inputState: SessionState,
): { state: SessionState; advanced: boolean } {
  const state = structuredClone(inputState);
  const previousStage = state.stage;
  updateStage(state);
  return { state, advanced: state.stage !== previousStage };
}

function discloseNextFragment(
  state: SessionState,
  preferredMemoryId: string | null,
  force: boolean,
): TurnResolution["newClues"][number] | null {
  const preferred = preferredMemoryId ? getMemory(state, preferredMemoryId) : undefined;
  const alreadyDisclosed = state.memories.filter((memory) =>
    memory.fragments.some((fragment) => fragment.disclosed)
  );
  const ordered = !force && preferred
    ? [preferred]
    : [
      ...(preferred ? [preferred] : []),
      ...alreadyDisclosed.filter((memory) => memory.id !== preferred?.id),
      ...state.memories.filter((memory) =>
        memory.id !== preferred?.id &&
        !alreadyDisclosed.some((item) => item.id === memory.id)
      ),
    ];

  for (const memory of ordered) {
    const fragment = memory.fragments.find((item) =>
      !item.disclosed && !item.contaminationOnly &&
      (force || memory.accessibility >= item.unlockAtAccessibility)
    );
    if (!fragment) continue;
    fragment.disclosed = true;
    memory.accessibility = Math.max(memory.accessibility, fragment.unlockAtAccessibility);
    return {
      memoryId: memory.id,
      fragmentId: fragment.id,
      text: fragment.text,
    };
  }
  return null;
}

function discloseUnstableFragment(
  state: SessionState,
  preferredMemoryId: string | null,
): TurnResolution["newClues"][number] | null {
  const ordered = [
    ...(preferredMemoryId ? state.memories.filter((memory) => memory.id === preferredMemoryId) : []),
    ...state.memories.filter((memory) => memory.id !== preferredMemoryId),
  ];
  for (const memory of ordered) {
    const fragment = memory.fragments.find((item) =>
      item.contaminationOnly && !item.disclosed
    );
    if (!fragment) continue;
    fragment.disclosed = true;
    return {
      memoryId: memory.id,
      fragmentId: fragment.id,
      text: fragment.text,
    };
  }
  return null;
}

function evaluateEnding(state: SessionState): void {
  if (state.ending) return;
  if (
    state.stage !== 3 ||
    state.turn < 10 ||
    !state.progress.submittedConclusion
  ) return;

  const compositeConfidence = state.claims.find(
    (claim) => claim.isCompositeIdentityClaim,
  )?.confidence ?? 0;
  const falseClaims = state.claims.filter(
    (claim) => claim.active && claim.canonicalStatus === "false",
  );
  const adoptedFalseClaims = falseClaims.length === 0
    ? 0
    : falseClaims.reduce((sum, claim) => sum + claim.confidence, 0) /
      falseClaims.length;

  const truthScore =
    0.45 * state.hidden.truthAlignment +
    0.25 * compositeConfidence +
    0.15 * state.status.clarity +
    0.15 * state.status.stability;
  const falseScore =
    0.35 * state.hidden.identityDominance +
    0.3 * adoptedFalseClaims +
    0.2 * state.status.stability +
    0.15 * state.status.trust;

  let type: "truth_healing" | "false_happiness" | null = null;
  if (truthScore >= 78) type = "truth_healing";
  if (falseScore >= 72 && falseScore >= truthScore) type = "false_happiness";

  if (!type) type = truthScore > falseScore + 5 ? "truth_healing" : "false_happiness";
  if (!type) return;

  const dominantSource = [...state.sources].sort((a, b) => b.weight - a.weight)[0];
  state.ending = {
    type,
    quality: state.status.stability >= 55 ? "stable" : "fragile",
    ...(type === "false_happiness" && dominantSource
      ? { variant: dominantSource.id }
      : {}),
  };
}

export function submitTreatmentConclusion(
  inputState: SessionState,
  conclusion: string,
  disposition: "interpret" | "defer" = "interpret",
): { state: SessionState; accepted: boolean; reason: string } {
  const state = structuredClone(inputState);
  const text = conclusion.trim();
  if (!text) return { state, accepted: false, reason: "empty_conclusion" };
  if (state.ending) return { state, accepted: false, reason: "already_ended" };
  if (disposition === "defer") {
    if (state.turn === 0) return { state, accepted: false, reason: "no_session_yet" };
    if (state.mode !== "normal" || state.forcedOperation) {
      return { state, accepted: false, reason: "crisis_unresolved" };
    }
    state.progress.submittedConclusion = text;
    state.ending = {
      type: "open_question",
      quality: state.status.stability >= 55 ? "stable" : "fragile",
    };
    return { state, accepted: true, reason: "open_question" };
  }
  if (state.stage < 3 && state.turn < 20) {
    return { state, accepted: false, reason: "conclusion_too_early" };
  }

  const truthStance = classifyCaseInsight(text) !== "none" ||
    /并非.{0,8}(?:自己|伊莱)/.test(text);
  const constructedStance = /让(?:他|伊莱)相信|选择一个|就是他的|当成自己的|忘掉|不必追究|幸福的版本|继续生活的版本/.test(text);
  state.progress.submittedConclusion = text;

  if (!truthStance && !constructedStance) {
    state.ending = { type: "treatment_interrupted", quality: "fragile" };
    return { state, accepted: true, reason: "inconclusive" };
  }

  if (truthStance && !constructedStance) {
    const composite = state.claims.find((claim) => claim.isCompositeIdentityClaim);
    if (composite) {
      composite.active = true;
      composite.confidence = Math.max(85, composite.confidence);
    }
    for (const claim of state.claims) {
      if (claim.canonicalStatus === "false") claim.confidence = Math.max(0, claim.confidence - 25);
    }
  } else {
    const dominant = [...state.sources].sort((a, b) => b.weight - a.weight)[0];
    const candidate = state.claims.find((claim) =>
      claim.canonicalStatus === "false" &&
      dominant && claim.sourceAffinity[dominant.id] >= 0.5
    );
    if (candidate) {
      candidate.active = true;
      candidate.confidence = Math.max(90, candidate.confidence);
    }
  }

  updateDerivedMetrics(state);
  state.stage = 3;
  evaluateEnding(state);
  return { state, accepted: true, reason: state.ending?.type ?? "submitted" };
}

export function resolveTurn(
  inputState: SessionState,
  intent: TurnIntent,
): TurnResolution {
  const state = structuredClone(inputState);
  const changes: string[] = [];
  const errors: string[] = [];
  const newClues: TurnResolution["newClues"] = [];
  let accepted = true;
  let partial = false;
  let acceptanceScore: number | null = null;
  let reactionMode: TurnResolution["reactionMode"] = "processed";

  if (state.ending) {
    return {
      state,
      accepted: false,
      partial: false,
      acceptanceScore: null,
      reactionMode: "resisted",
      changes,
      errors: ["session_already_ended"],
      newClues,
    };
  }
  if (state.forcedOperation && intent.operation !== state.forcedOperation) {
    return {
      state,
      accepted: false,
      partial: false,
      acceptanceScore: null,
      reactionMode: "resisted",
      changes,
      errors: [`operation_forced:${state.forcedOperation}`],
      newClues,
    };
  }

  const focus = intent.focus ?? "memory";
  const memory = getMemory(state, intent.targetMemoryId);
  if (focus === "memory" && !memory) {
    return {
      state,
      accepted: false,
      partial: false,
      acceptanceScore: null,
      reactionMode: "resisted",
      changes,
      errors: ["invalid_memory_id"],
      newClues,
    };
  }

  state.turn += 1;
  state.intervention.streak = state.intervention.lastOperation === intent.operation
    ? state.intervention.streak + 1
    : 1;
  state.intervention.lastOperation = intent.operation;
  const fatigued = state.intervention.streak >= 3;
  const inquiryTrustPenaltyAllowed = state.intervention.streak > 5;
  if (fatigued) changes.push(`intervention_fatigue:${intent.operation}`);
  const points = MAGNITUDE_POINTS[intent.magnitude];
  const previousConflict = calculateConflictPressure(state);
  let claim = getClaim(state, intent.claimId);
  let pendingImplant:
    | { claim: MemoryClaim; memory: MemoryNode; linkedClaimId?: string }
    | undefined;

  if (intent.operation === "inquire" && memory) {
    if (claim && claim.memoryId !== memory.id) {
      return {
        state: structuredClone(inputState),
        accepted: false,
        partial: false,
        acceptanceScore: null,
        reactionMode: "resisted",
        changes: [],
        errors: ["claim_memory_mismatch"],
        newClues: [],
      };
    }
    const guarded = state.status.trust < 25;
    memory.accessibility = clamp(memory.accessibility + (guarded || fatigued ? 1 : points));
    state.status.clarity = clamp(state.status.clarity + (fatigued ? 1 : round(points / 2)));
    state.status.stability = clamp(
      state.status.stability - Math.max(1, round(points / 4)) - (fatigued ? 2 : 0),
    );
    state.status.trust = clamp(
      state.status.trust +
        (intent.tone === "supportive" ? 1 : intent.tone === "pressuring" && inquiryTrustPenaltyAllowed ? -4 : 0) -
        (fatigued && inquiryTrustPenaltyAllowed ? 4 : 0),
    );
    if (claim) {
      claim.active = true;
      claim.origin = "discovered";
      applySourceDrift(state, claim, intent.operation, points);
    }
    changes.push(`accessibility:${memory.id}`);
    if (guarded) changes.push("inquiry_guarded_by_low_trust");
    const discovered = guarded || fatigued
      ? null
      : state.status.stability < 40
      ? discloseUnstableFragment(state, memory.id)
      : discloseNextFragment(state, memory.id, false);
    if (discovered) {
      newClues.push(discovered);
      changes.push(`disclosed:${discovered.fragmentId}`);
      if (state.status.stability < 40) changes.push("unstable_clue_disclosed");
    }
  }

  if (intent.operation === "empathize" && memory) {
    if (claim && claim.memoryId !== memory.id) {
      return {
        state: structuredClone(inputState),
        accepted: false,
        partial: false,
        acceptanceScore: null,
        reactionMode: "resisted",
        changes: [],
        errors: ["claim_memory_mismatch"],
        newClues: [],
      };
    }
    const trustGain = fatigued ? 1 : round(points * 0.6);
    const stabilityGain = fatigued ? 1 : round(points * 0.5);
    state.status.trust = clamp(state.status.trust + trustGain);
    state.status.stability = clamp(state.status.stability + stabilityGain);
    memory.emotionIntensity = clamp(memory.emotionIntensity - points);
    memory.strength = clamp(memory.strength + Math.max(1, round(points * 0.25)));
    if (claim && intent.implicitFactConfirmation) {
      claim.active = true;
      claim.confidence = clamp(claim.confidence + Math.max(1, round(points / 6)));
      applySourceDrift(state, claim, intent.operation, points);
      changes.push(`implicitly_strengthened:${claim.id}`);
    }
    if (state.mode === "collapse") {
      state.mode = "normal";
      state.forcedOperation = null;
      state.rescueUsed.stability = true;
      state.status.stability = Math.max(30, state.status.stability);
      changes.push("collapse_recovered");
    } else if (state.mode === "rupture") {
      state.mode = "normal";
      state.forcedOperation = null;
      state.rescueUsed.trust = true;
      state.status.trust = Math.max(25, state.status.trust);
      changes.push("rupture_recovered");
    }
  }

  if (intent.operation === "suggest" && memory) {
    if (intent.implant) {
      pendingImplant = prepareImplant(state, intent, points, errors);
      claim = pendingImplant?.claim;
    }
    if (!claim) {
      accepted = false;
      reactionMode = "resisted";
      if (errors.length === 0) errors.push("missing_claim");
    } else {
      if (!pendingImplant && claim.memoryId !== memory.id) {
        return {
          state: structuredClone(inputState),
          accepted: false,
          partial: false,
          acceptanceScore: null,
          reactionMode: "resisted",
          changes: [],
          errors: ["claim_memory_mismatch"],
          newClues: [],
        };
      }
      acceptanceScore = calculateSuggestionAcceptance(state, claim);
      accepted = acceptanceScore >= 40;
      partial = acceptanceScore >= 40 && acceptanceScore < 65;
      reactionMode = acceptanceScore >= 65
        ? "accepted"
        : partial
        ? "partial"
        : "resisted";

      if (accepted) {
        const appliedPoints = partial ? round(points / 2) : points;
        if (pendingImplant) {
          state.memories.push(pendingImplant.memory);
          state.claims.push(pendingImplant.claim);
          if (pendingImplant.linkedClaimId) {
            state.conflicts.push({
              leftClaimId: pendingImplant.claim.id,
              rightClaimId: pendingImplant.linkedClaimId,
              weight: 0.2,
            });
          }
          changes.push(`created:${pendingImplant.memory.id}`);
          newClues.push({
            memoryId: pendingImplant.memory.id,
            fragmentId: pendingImplant.memory.fragments[0]!.id,
            text: pendingImplant.memory.fragments[0]!.text,
          });
        }
        claim.active = true;
        claim.origin = claim.origin === "player_implanted"
          ? "player_implanted"
          : "player_suggestion";
        const direction = intent.claimDirection === "weaken" ? -1 : 1;
        claim.confidence = clamp(claim.confidence + direction * appliedPoints);
        state.status.clarity = clamp(state.status.clarity - Math.max(1, round(appliedPoints / 3)));
        const contradictionRisk = calculateContradictionRisk(state, claim);
        state.status.stability = clamp(
          state.status.stability + (contradictionRisk >= 40 ? -round(appliedPoints / 2) : 2),
        );
        state.status.trust = clamp(state.status.trust + (partial ? 0 : 1));
        applySourceDrift(state, claim, intent.operation, appliedPoints);
        changes.push(`${intent.claimDirection ?? "strengthen"}:${claim.id}`);
      } else {
        state.status.trust = clamp(state.status.trust - 4);
        state.status.stability = clamp(state.status.stability - 1);
      }
      if (fatigued) state.status.trust = clamp(state.status.trust - 3);
    }
  }

  if (focus === "present_context") {
    if (intent.operation === "empathize") {
      state.status.trust = clamp(state.status.trust + round(points * 0.5));
      state.status.stability = clamp(state.status.stability + round(points * 0.25));
    } else {
      state.status.trust = clamp(
        state.status.trust +
          (intent.tone === "supportive" ? 1 : intent.tone === "pressuring" &&
            (intent.operation !== "inquire" || inquiryTrustPenaltyAllowed) ? -2 : 0),
      );
    }
    changes.push("present_context_response");
    if (intent.operation === "empathize" && state.mode === "collapse") {
      state.mode = "normal";
      state.forcedOperation = null;
      state.rescueUsed.stability = true;
      state.status.stability = Math.max(30, state.status.stability);
      changes.push("collapse_recovered");
    } else if (intent.operation === "empathize" && state.mode === "rupture") {
      state.mode = "normal";
      state.forcedOperation = null;
      state.rescueUsed.trust = true;
      state.status.trust = Math.max(25, state.status.trust);
      changes.push("rupture_recovered");
    }
  }

  if (memory) state.progress.lastTargetMemoryId = memory.id;
  if (intent.operation === "inquire") {
    state.progress.noClueTurns = newClues.length > 0
      ? 0
      : state.progress.noClueTurns + 1;
  }
  if (
    intent.operation === "inquire" &&
    !fatigued &&
    state.status.trust >= 25 &&
    state.progress.noClueTurns >= 2 &&
    state.mode === "normal"
  ) {
    const assisted = discloseNextFragment(
      state,
      state.progress.lastTargetMemoryId,
      true,
    );
    if (assisted) {
      newClues.push(assisted);
      changes.push(`assisted_disclosure:${assisted.fragmentId}`);
      state.progress.noClueTurns = 0;
    }
  }

  updateDerivedMetrics(state);
  applyConflictConsequences(state, previousConflict);
  updateDerivedMetrics(state);

  if (
    state.status.stability <= 20 ||
    state.hidden.conflictPressure >= 80 ||
    inputState.status.stability - state.status.stability >= 20
  ) {
    if (state.rescueUsed.stability) {
      state.ending = { type: "treatment_interrupted", quality: "fragile" };
      changes.push("second_collapse_failed");
    } else {
      state.mode = "collapse";
      state.forcedOperation = "empathize";
      changes.push("collapse_triggered");
    }
  } else if (state.status.trust <= 15) {
    if (state.rescueUsed.trust) {
      state.ending = { type: "treatment_interrupted", quality: "fragile" };
      changes.push("second_rupture_failed");
    } else {
      state.mode = "rupture";
      state.forcedOperation = "empathize";
      changes.push("rupture_triggered");
    }
  }

  updateStage(state);
  evaluateEnding(state);

  return {
    state,
    accepted,
    partial,
    acceptanceScore,
    reactionMode,
    changes,
    errors,
    newClues,
  };
}
