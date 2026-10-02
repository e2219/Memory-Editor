import type { CaseMail, SessionState } from "./types.ts";

const hasDisclosedFragment = (state: SessionState, fragmentId: string): boolean =>
  state.memories.some((memory) =>
    memory.fragments.some((fragment) => fragment.id === fragmentId && fragment.disclosed)
  );

export function deliverAvailableMail(
  inputState: SessionState,
): { state: SessionState; delivered: CaseMail[] } {
  const state = structuredClone(inputState);
  const delivered: CaseMail[] = [];
  const shouldDeliver: Record<string, boolean> = {
    mail_contact_summary: state.turn >= 5,
    mail_lin_orange: hasDisclosedFragment(state, "orange_hands"),
    mail_xu_station: hasDisclosedFragment(state, "station_red_boots"),
    mail_handedness_check: state.turn >= 11,
    mail_shen_stability: state.stage >= 2 || state.turn >= 14,
    mail_platform_alias: state.stage === 3 && hasDisclosedFragment(state, "glass_confirm"),
    mail_xu_recording: hasDisclosedFragment(state, "rooftop_lie"),
    mail_lin_concern: state.stage === 3 && state.status.clarity >= 60,
    mail_session_deadline: state.turn >= 20,
  };

  for (const mail of state.mailbox) {
    if (mail.status !== "unavailable" || !shouldDeliver[mail.id]) continue;
    mail.status = "unread";
    mail.deliveredAtTurn = state.turn;
    delivered.push(structuredClone(mail));
  }
  return { state, delivered };
}

export function classifyCaseInsight(
  text: string,
): "none" | "discontinuity" | "multiple_sources" {
  const normalized = text.trim();
  if (
    /不同的?人|不止一个|多个人|别人(?:的)?记忆|不属于(?:伊莱|他)|多个来源|不同阶段.{0,8}记忆|记忆.{0,10}(?:输入|植入|塞进)|后天.{0,10}(?:输入|植入)|人为.{0,10}(?:输入|植入)/.test(
      normalized,
    )
  ) return "multiple_sources";
  if (
    /拼接|接缝|两段|不是同一|并非同一|不连贯|前因后果|混在一起|记忆混乱|记乱|分开的场景/.test(
      normalized,
    )
  ) return "discontinuity";
  return "none";
}

export function visibleMail(state: SessionState): CaseMail[] {
  return state.mailbox.filter((mail) => mail.status !== "unavailable");
}

export function updateMailStatus(
  inputState: SessionState,
  mailId: string,
  status: "read" | "ignored",
): SessionState {
  const state = structuredClone(inputState);
  const mail = state.mailbox.find((candidate) => candidate.id === mailId);
  if (mail && mail.status !== "unavailable") mail.status = status;
  return state;
}

export function recordCaseNote(inputState: SessionState, text: string): SessionState {
  const state = structuredClone(inputState);
  const normalized = text.trim();
  const insight = classifyCaseInsight(normalized);
  state.caseNotes.push({
    id: `note_${state.caseNotes.length + 1}`,
    createdAtTurn: state.turn,
    text: normalized,
    revisedFromId: null,
    focused: false,
    insight,
  });
  return state;
}

export function focusCaseNote(inputState: SessionState, noteId: string): SessionState {
  const state = structuredClone(inputState);
  for (const note of state.caseNotes) note.focused = note.id === noteId;
  return state;
}
