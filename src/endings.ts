import type { SessionState } from "./types.ts";

function remainingQuestions(state: SessionState): string {
  const known = new Set(state.memories.flatMap((memory) => memory.fragments
    .filter((fragment) => fragment.disclosed && fragment.reliability === "grounded")
    .map((fragment) => fragment.id)));
  // Refer only to encountered material, never to the hidden background or unopened mail.
  // These questions concern gaps that the current evidence model cannot establish.
  const questions: Array<[string, string]> = [
    ["replace_pain", "那个提出替换痛苦记忆的人，究竟想让伊莱过上怎样的生活"],
    ["three_answers", "反复要求他选择答案的声音来自谁"],
    ["glass_name", "玻璃后呼唤伊莱的人是谁"],
    ["rooftop_recorder", "那台藏在楼顶的录音机为什么会出现在他的回忆里"],
    ["blue_tie", "那场会议为何要求他照稿道歉"],
    ["locked_key", "掌心里的钥匙究竟能打开哪扇门"],
    ["locked_room", "那间无窗的房间在哪里"],
    ["missed_call", "那通没有接起的电话来自谁"],
    ["station_waiting", "站台上迟迟没有出现的人是谁"],
    ["orange_scene", "厨房里削橙子的人是谁"],
  ];
  const selected = questions.filter(([id]) => known.has(id)).slice(0, 2).map(([, text]) => text);
  return selected.length
    ? `${selected.join("；")}——现有记录仍不足以核实。`
    : "三位联系人提供的身世是否完整，现有记录仍不足以核实。";
}

export function endingSummary(state: SessionState): { title: string; text: string } {
  if (!state.ending) throw new Error("session_not_ended");
  const questions = remainingQuestions(state);
  switch (state.ending.type) {
    case "open_question":
      return {
        title: "带着疑问离开",
        text: (state.ending.quality === "stable"
          ? "你在结论中留下了‘暂不定论’。伊莱的状态还算平稳，你决定把这一点留给他，而不是用最后几句话逼出一个完整的身世。记录里仍有空白，你没有把它们填成事实。"
          : "你在结论中留下了‘暂不定论’。伊莱的状态仍不平稳，再追问下去，也未必能分清新出现的细节是回忆还是压力下的解释。你结束了这次会谈，没有宣告治愈，也没有替他认领一段过去。") +
          `\n\n${questions}你保留了这些问题，也保留了以后推翻自己判断的余地。这次停下，是你作出的治疗决定。`,
      };
    case "truth_healing":
      return {
        title: "真相治愈",
        text: (state.ending.quality === "stable"
          ? "最后的治疗记录没有给伊莱补上一份完整履历。你把记忆的来历与他此刻的感受分开处理；会谈结束时，他的状态仍然平稳。这为他留下了一点余地：有些经历可以继续核实，不必急着全都认作自己的人生。"
          : "你把记忆的来历与伊莱此刻的感受分开写进结论，但他的状态还很脆弱。发现裂缝没有立刻带来轻松；会谈停在这里，接下来需要的照顾仍未结束。") +
          `\n\n${questions}你的结论给出了理解这些片段的方向，却没有替每个疑点找到证人。这个结局也不意味着伊莱已经知道或接受了你所有的判断。`,
      };
    case "false_happiness":
      return {
        title: "虚假幸福",
        text: (state.ending.quality === "stable"
          ? "会谈结束时，伊莱的状态还算平稳，一种更容易继续生活的解释占了上风。那些难以归位的片段没有被一一解开，却不再妨碍这份记录讲出一个连贯的故事。这样的安稳，暂时容得下他。"
          : "一种更容易继续生活的解释占了上风，但伊莱的状态仍然脆弱。故事有了接得下去的说法，疑点却还留在原处；这份安稳能维持多久，本次会谈没有给出答案。") +
          `\n\n${questions}如果这些疑点以后再次出现，眼下的解释还撑得住吗？你留下了一个可以继续相信的版本，也留下了没有被它解释的部分。`,
      };
    case "treatment_interrupted":
      return {
        title: "治疗中止",
        text: (state.mode === "collapse" || state.status.stability <= 20 || state.hidden.conflictPressure >= 80
          ? "会谈结束时，伊莱已经难以承受继续追问。你们接触到的片段还没有整理清楚，交流就先到了极限。记录停在这里，并不说明此前的怀疑全都错了；只是这次治疗没能把它们带到可以承受的地方。"
          : state.mode === "rupture" || state.status.trust <= 15
          ? "你和伊莱之间的信任已经不足以支撑会谈。记录里还留着没有回答的问题，但继续要求他解释自己，已无法换来有效的交流。这次治疗在形成共同理解之前结束了。"
          : "这次会谈结束了，却没有留下足以继续治疗的结论。有些问题你已经问出口，有些还没找到合适的问法；屏幕上的记录保存了这段接触，没有替它补上一个圆满的收尾。") +
          `\n\n${questions}这些疑点不会因为治疗中止而得到答案。如果你选择查看故事背景，那是会谈之外的揭底，不代表伊莱在这一局里获知了真相。`,
      };
  }
}
