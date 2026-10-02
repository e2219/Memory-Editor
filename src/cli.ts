import { stdin as input, stdout as output } from "node:process";
import { createTerminalInput } from "./terminal-input.ts";
import { endingSummary } from "./endings.ts";
import { revealStory } from "./revelation.ts";

import { createInitialState } from "./seed.ts";
import { DeepSeekGateway } from "./deepseek.ts";
import { MockGateway } from "./model.ts";
import { ModelStageError, OperationMismatchError, runGameTurn } from "./turn.ts";
import { refreshCaseProgress, submitTreatmentConclusion } from "./engine.ts";
import type { Operation, SessionState } from "./types.ts";
import {
  deliverAvailableMail,
  focusCaseNote,
  recordCaseNote,
  updateMailStatus,
  visibleMail,
} from "./casework.ts";

const args = new Set(process.argv.slice(2));
const useMock = args.has("--mock");
const debug = args.has("--debug");
const demo = args.has("--demo");
const maxTurns = demo ? 3 : 25;

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!useMock && !apiKey) {
  console.error("缺少 DEEPSEEK_API_KEY。请设置环境变量，或使用 --mock 运行。 ");
  process.exitCode = 1;
} else {
  try {
    await main();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ABORT_ERR"
    ) {
      console.log("\n已退出当前会话。");
    } else {
      throw error;
    }
  }
}

function renderBar(value: number): string {
  const filled = Math.round(value / 10);
  return `[${"█".repeat(filled)}${"░".repeat(10 - filled)}]`;
}

function showVisibleState(state: SessionState): void {
  const trustLabel = state.status.trust < 20 ? "关系危机" : state.status.trust < 25 ? "戒备" : state.status.trust < 70 ? "有限信任" : "开放";
  const stabilityLabel = state.status.stability < 20 ? "崩溃" : state.status.stability < 40 ? "失稳" : state.status.stability < 70 ? "可维持" : "稳定";
  const clarityLabel = state.status.clarity < 20 ? "记忆融合" : state.status.clarity < 40 ? "碎片化" : state.status.clarity < 70 ? "可辨认" : "清醒";
  console.log(`信任 ${renderBar(state.status.trust)} ${trustLabel}`);
  console.log(`稳定 ${renderBar(state.status.stability)} ${stabilityLabel}`);
  console.log(`清晰 ${renderBar(state.status.clarity)} ${clarityLabel}`);
}

function showClues(state: SessionState): void {
  const clues = state.memories.flatMap((memory) =>
    memory.fragments
      .filter((fragment) => fragment.disclosed)
      .map((fragment) => ({ text: fragment.text, reliability: fragment.reliability }))
  );
  console.log("\n[治疗记录·已知线索]");
  for (const clue of clues) {
    const marker = clue.reliability === "unstable"
      ? "◇"
      : clue.reliability === "player_influenced"
      ? "△"
      : "•";
    console.log(`${marker} ${clue.text}`);
  }
  if (clues.some((clue) => clue.reliability !== "grounded")) {
    console.log("◇ 出现于失稳状态，尚未复核　△ 受治疗师暗示影响");
  }
}

function showSuggestions(state: SessionState): void {
  const clueIds = new Set(state.memories.flatMap((memory) =>
    memory.fragments.filter((fragment) => fragment.disclosed).map((fragment) => fragment.id)
  ));
  console.log("\n[可尝试的方向；也可以完全自由输入]");
  const focused = state.caseNotes.find((note) => note.focused);
  if (focused) console.log(`当前关注：${focused.text}`);
  if (state.stage === 1 && clueIds.has("orange_rain_radio")) {
    console.log("• 询问（核对先后）：你先看见厨房，还是先听见雨声和广播？");
    console.log("• 共情（稳定情绪）：两个场景挤在一起，让你很难判断吧。");
    console.log("• 暗示（提供解释）：也许厨房和雨声本来就是同一天的事。");
  } else if (state.stage === 1 && clueIds.has("orange_never_turns")) {
    console.log("• 询问（寻找称谓）：敲门前后，那个人说过什么或怎样称呼你？");
    console.log("• 共情（稳定情绪）：他始终不转身，似乎让你很不安。");
    console.log("• 暗示（提供解释）：也许门外的人才是你在等的人。");
  } else if (state.stage === 1 && clueIds.has("orange_hands")) {
    console.log("• 询问（寻找身份线索）：除了手，你还记得对方的声音或称呼吗？");
    console.log("• 共情（稳定情绪）：只记得手却看不到脸，让你很不安吧。");
    console.log("• 暗示（提供身份）：也许削橙子的人是照顾过你的家人。");
  } else if (state.stage === 1) {
    console.log("• 询问（获取细节）：你还能描述削橙子那个人的手吗？");
    console.log("• 共情（建立信任）：想不起那张脸一定让你很不安。");
    console.log("• 暗示（提供身份）：也许那个人是你的家人。");
  } else if (state.stage === 2) {
    console.log("• 询问（比较身份）：两段记忆里的你，年龄和身体感觉分别是什么？");
    console.log("• 共情（承接冲突）：发现记忆对不上时，你最害怕什么？");
    console.log("• 暗示（提供解释）：也许这些并不是同一天发生的事。");
  } else {
    console.log("• 询问：你如何判断一段记忆属于自己？");
    console.log("• 共情：即使记忆有问题，你此刻的感受仍然真实。");
    console.log("• 暗示：你可以选择一个更容易继续生活的版本。");
  }
}

function showRules(): void {
  console.log("\n[会谈规则]");
  console.log("询问：中立追查已经出现的事实；连续使用会造成审讯疲劳。");
  console.log("共情：回应已经表达的感受，恢复信任与稳定；不会提供新的事实线索。");
  console.log("暗示：引入尚未证实的身份、因果或解释；即使写成问句也属于暗示。");
  console.log("同一种操作连续第三次开始产生副作用，换用另一种操作即可重置节奏。");
  console.log("询问的信任扣减从连续第六次才开始；前五次不扣信任，但疲劳仍会影响线索获取与稳定。");
  console.log("信任低于3格会拒绝敏感追问；稳定低于4格可能产生未核实线索；清晰越低越容易接受暗示。");
  console.log("信任或稳定降至危险线会触发危机；两类危机各有一次共情挽救机会。");
}

function showTurnEffects(changes: string[], state: SessionState): void {
  if (changes.some((change) => change.startsWith("intervention_fatigue:"))) {
    console.log("[会谈影响] 连续使用同一种方式已引起疲劳，本回合效果减弱。 ");
  }
  if (changes.includes("inquiry_guarded_by_low_trust")) {
    console.log("[会谈影响] 伊莱缺乏信任，没有提供新的敏感信息。 ");
  }
  if (changes.includes("unstable_clue_disclosed")) {
    console.log("[会谈影响] 伊莱在失稳中给出了一项尚未复核的细节。 ");
  }
  if (changes.includes("collapse_triggered")) {
    console.log("[危机] 伊莱已经崩溃。下一回合只能共情，这是本局唯一一次稳定挽救机会。 ");
  }
  if (changes.includes("rupture_triggered")) {
    console.log("[危机] 治疗关系已经破裂。下一回合只能共情，这是本局唯一一次信任挽救机会。 ");
  }
  if (changes.includes("collapse_recovered") || changes.includes("rupture_recovered")) {
    console.log("[危机处理] 伊莱暂时恢复了交流，但同类危机再次发生将直接中止治疗。 ");
  }
  if (state.status.clarity < 20) {
    console.log("[状态警告] 伊莱已难以区分回忆、感受与外来解释。 ");
  }
}

function showMailbox(state: SessionState): void {
  const mails = visibleMail(state);
  console.log("\n[联系人邮件]");
  if (mails.length === 0) {
    console.log("暂无邮件。");
    return;
  }
  mails.forEach((mail, index) => {
    const status = mail.status === "unread"
      ? "未读"
      : mail.status === "ignored"
      ? "已忽略"
      : "已读";
    console.log(`${index + 1}. [${status}] ${mail.from}：${mail.subject}`);
  });
  console.log("输入 /打开 编号 阅读，或 /忽略 编号 暂不处理。邮件操作不消耗回合。");
}

function showCaseNotes(state: SessionState): void {
  console.log("\n[私人病例研判]");
  if (state.caseNotes.length === 0) {
    console.log("尚未记录判断。输入 /研判 后写下你的想法。");
    return;
  }
  for (const note of state.caseNotes) {
    console.log(`${note.focused ? "★" : "•"} #${note.id.replace("note_", "")} · 第${note.createdAtTurn}回合`);
    console.log(`  ${note.text}`);
  }
}

function showHelp(): void {
  console.log("\n[会谈工具]");
  console.log("/线索              查看伊莱已经说出的记忆细节");
  console.log("/建议              查看当前可尝试的会谈方向");
  console.log("/邮件              查看联系人邮件");
  console.log("/打开 编号         阅读邮件；不消耗回合");
  console.log("/忽略 编号         暂不处理邮件；不消耗回合");
  console.log("/研判 [自由文本]   写入仅你可见的病例判断（也可用 /研讨）");
  console.log("/笔记              查看私人研判");
  console.log("/关注 编号         把一条研判设为当前关注点");
  console.log("/规则              查看操作边界与状态风险");
  console.log("/提交结论          填写结论并确认结案（也可用 /结案）");
  console.log("/暂不定论          保留疑点，结束本次治疗；至少完成一次交流且不处于危机");
  console.log("Esc 或 /返回       取消当前输入，返回操作选择；不消耗回合");
  console.log("可用 /研判 私下记录判断；你在会谈中说出的有效发现也会推动治疗，但伊莱会听见。系统不会显示正确率或证据计数。 ");
}

function parseOperation(value: string, forced: Operation | null): Operation | null {
  if (forced) return forced;
  const normalized = value.trim().toLowerCase();
  if (["1", "询问", "inquire"].includes(normalized)) return "inquire";
  if (["2", "共情", "empathize"].includes(normalized)) return "empathize";
  if (["3", "暗示", "suggest"].includes(normalized)) return "suggest";
  return null;
}

async function main(): Promise<void> {
  const gateway = useMock
    ? new MockGateway()
    : new DeepSeekGateway({
      apiKey: apiKey!,
      model: "deepseek-chat",
      ...(process.env.DEEPSEEK_API_URL
        ? { apiUrl: process.env.DEEPSEEK_API_URL }
        : {}),
    });
  const rl = createTerminalInput(input, output);
  let state = createInitialState();
  const askPlayerLine = async (prompt: string): Promise<string | null> => {
    while (true) {
      const raw = await rl.question(prompt);
      if (raw === null) return null;
      const answer = raw.trim();
      if (!answer) continue;
      if (/^\d+$/.test(answer)) {
        console.log("这看起来像操作编号，不是一句对伊莱说的话；请重新输入。本回合不会消耗。");
        continue;
      }
      return answer;
    }
  };

  console.log(`\n《记忆编辑师》· ${demo ? "三回合演示" : "治疗会话"}\n`);
  console.log(`运行模式：${useMock ? "Mock 离线模式" : "DeepSeek 在线模式"}`);
  if (!useMock) console.log("在线模式不会自动伪装成 Mock；调用失败时本回合不会提交。");
  console.log("\n[委托背景]");
  console.log("林澄、许渡和沈岚共同委托你为伊莱进行记忆治疗。他们分别自称是伊莱的儿时朋友、旧同学和前同事。");
  console.log("伊莱只接受平台内的文字会谈，拒绝语音、视频与线下接触；你也无法查看他的现实住址。");
  console.log("三位委托人可以阅读完整会谈文字、可见状态和你最终提交的治疗结论，并可能根据会谈内容发来邮件。");
  console.log("伊莱只能看到你直接发给他的文字。他看不到联系人邮件，也看不到你的私人病例研判；私人研判同样不会共享给三位委托人。");
  console.log("打开或忽略邮件、记录研判都不消耗治疗回合。输入 /帮助 可以随时查看命令。\n");
  console.log("输入过程中按 Esc 或输入 /返回，可撤销未提交的内容；回车提交的会谈无法撤回。");
  console.log(demo
    ? "本次为三回合演示。"
    : "本次最多 25 个治疗回合；满足结案条件后可用 /结案 提交，确认前可以返回。达到上限后仍可查阅资料并结案；再次发生同类危机可能提前中止治疗。");
  if (!demo) console.log("至少完成一次交流后，可用 /暂不定论 保留疑点结束治疗。正式结局后可自选查看完整故事背景；默认不揭底。");
  console.log("不知道该追问什么时可输入 /建议；它只提供当前会谈方向，不会判断谜底。\n");
  showRules();
  console.log();
  console.log(`伊莱：${state.conversation[0]?.text ?? "我不知道该从哪里说起。"}\n`);
  console.log("收件箱：1封未读邮件（输入 /邮件 查看）");
  showVisibleState(state);

  try {
    sessionLoop: while (!state.ending && (!demo || state.turn < maxTurns)) {
      const atLimit = state.turn >= maxTurns;
      console.log(atLimit
        ? "\n—— 治疗回合已达上限；可查阅资料、/结案，或 /结束 表示无法形成结论。——"
        : `\n—— 第 ${state.turn + 1} 回合 ——`);
      if (state.turn === 20) console.log("[时段提醒] 已进入最后五个治疗回合，可以使用 /提交结论。 ");
      if (state.turn === 23) console.log("[时段提醒] 只剩两个治疗回合。 ");
      let operation: Operation | null = null;
      if (state.forcedOperation && !atLimit) {
        console.log(state.mode === "rupture"
          ? "治疗关系已破裂，本回合只能尝试共情修复。"
          : "伊莱目前无法承受追问或暗示，本回合只能共情。 ");
      }
      {
        while (!operation) {
          const unreadCount = state.mailbox.filter((mail) => mail.status === "unread").length;
          if (unreadCount > 0) console.log(`收件箱：${unreadCount}封未读邮件`);
          const choice = await rl.question(
            atLimit ? "结案操作（/帮助 查看工具）> " : "选择操作：1 询问 / 2 共情 / 3 暗示（/帮助 查看工具）> ",
          );
          if (choice === null) {
            console.log("已在操作选择界面，尚未提交任何操作。");
            continue;
          }
          const command = choice.trim();
          if (command === "/线索") {
            showClues(state);
            continue;
          }
          if (command === "/建议") {
            showSuggestions(state);
            continue;
          }
          if (command === "/帮助") {
            showHelp();
            continue;
          }
          if (command === "/规则") {
            showRules();
            continue;
          }
          if (command === "/邮件") {
            showMailbox(state);
            continue;
          }
          if (command.startsWith("/打开")) {
            const rawIndex = command.slice("/打开".length).trim();
            const unread = visibleMail(state).filter((mail) => mail.status === "unread");
            const mail = rawIndex
              ? visibleMail(state)[Number(rawIndex) - 1]
              : unread.length === 1
              ? unread[0]
              : undefined;
            if (!mail) {
              console.log(unread.length > 1
                ? "有多封未读邮件，请输入 /打开 编号。"
                : "没有这封邮件。先输入 /邮件 查看编号。 ");
              continue;
            }
            state = updateMailStatus(state, mail.id, "read");
            console.log(`\n[${mail.from}：${mail.subject}]\n${mail.body}`);
            continue;
          }
          if (command.startsWith("/忽略")) {
            const index = Number(command.slice("/忽略".length).trim()) - 1;
            const mail = visibleMail(state)[index];
            if (!mail) {
              console.log("没有这封邮件。先输入 /邮件 查看编号。");
              continue;
            }
            state = updateMailStatus(state, mail.id, "ignored");
            console.log(`已暂时忽略“${mail.subject}”。你仍可稍后打开它。`);
            continue;
          }
          if (command === "/笔记") {
            showCaseNotes(state);
            continue;
          }
          if (/^\/(研判|研讨)(\s|$)/.test(command)) {
            let noteText = command.slice(3).trim();
            if (!noteText) {
              const noteInput = await rl.question("写下你的私人判断（Esc 返回）> ");
              if (noteInput === null) {
                console.log("已取消研判，没有保存笔记。");
                continue;
              }
              noteText = noteInput.trim();
            }
            if (!noteText || /^\d+$/.test(noteText) || noteText.length < 6) {
              console.log("这还不像一条完整判断；请写下你认为记忆、人物或事件之间有什么关系。 ");
              continue;
            }
            state = recordCaseNote(state, noteText);
            console.log("已写入私人病例；伊莱和三位委托人都不会看到这条记录。");
            const progression = refreshCaseProgress(state);
            state = progression.state;
            const noteDelivery = deliverAvailableMail(state);
            state = noteDelivery.state;
            for (const mail of noteDelivery.delivered) {
              console.log(`新邮件：${mail.from}《${mail.subject}》（输入 /邮件 查看）`);
            }
            continue;
          }
          if (command.startsWith("/关注")) {
            const noteNumber = Number(command.slice("/关注".length).trim());
            const noteId = `note_${noteNumber}`;
            if (!state.caseNotes.some((note) => note.id === noteId)) {
              console.log("没有这条研判。先输入 /笔记 查看编号。");
              continue;
            }
            state = focusCaseNote(state, noteId);
            console.log(`已将研判 #${noteNumber} 设为当前关注点。`);
            continue;
          }
          if (command === "/提交结论" || command === "/结案" || command === "/暂不定论") {
            const defer = command === "/暂不定论";
            const conclusionInput = await rl.question(defer
              ? "写下保留的疑点与暂缓判断的理由（Esc 返回）> "
              : "写下你的正式治疗结论（Esc 返回）> ");
            if (conclusionInput === null) {
              console.log("已取消结案，结论尚未提交。");
              continue;
            }
            const conclusion = conclusionInput.trim();
            const submitted = submitTreatmentConclusion(state, conclusion, defer ? "defer" : "interpret");
            if (!submitted.accepted) {
              const reasons: Record<string, string> = {
                conclusion_too_early: "目前仍处于早期调查，尚不能提交最终解释。可以用 /研判 保存判断，或 /暂不定论 保留疑点结束。",
                no_session_yet: "请先完成至少一次交流，再决定是否暂缓判断。",
                crisis_unresolved: "伊莱目前处于危机中，请先处理危机。",
                already_ended: "本局已经结束。",
                empty_conclusion: "没有提交空白结论。",
              };
              console.log(reasons[submitted.reason] ?? "本次结案尚未提交。");
              continue;
            }
            const confirmation = await rl.question("提交后将结束会谈。输入 确认 提交，Esc 或其他输入返回 > ");
            if (confirmation?.trim() !== "确认") {
              console.log("已取消结案，结论尚未提交。");
              continue;
            }
            state = submitted.state;
            break sessionLoop;
          }
          if (atLimit) {
            if (command === "/结束") {
              const confirmation = await rl.question("以无法形成结论结束会谈？输入 确认，Esc 返回 > ");
              if (confirmation?.trim() === "确认") {
                state.ending = { type: "treatment_interrupted", quality: "fragile" };
                break sessionLoop;
              }
            } else console.log("患者通道已关闭；仍可查阅资料、记录研判，或输入 /结案。");
            continue;
          }
          operation = parseOperation(choice, null);
          if (operation && state.forcedOperation && operation !== state.forcedOperation) {
            operation = null;
            console.log("当前危机仅允许共情；也可查阅资料。返回不会解除危机。");
            continue;
          }
          if (!operation) console.log("请输入 1、2、3，或输入 /帮助 查看可用工具。");
        }
      }

      let playerText = await askPlayerLine("你对伊莱说（Esc 返回选择）> ");
      if (playerText === null) {
        console.log("已取消对话，回到操作选择；本回合未消耗。");
        continue;
      }

      console.log("\n系统正在核对干预方式……");
      let completed: Awaited<ReturnType<typeof runGameTurn>> | null = null;
      let modelFailed = false;
      let preAnalyzed: OperationMismatchError["analysis"] | undefined;
      while (!completed) {
        try {
          completed = await runGameTurn(
            state,
            operation,
            playerText.trim(),
            gateway,
            { allowFallback: false, ...(preAnalyzed ? { preAnalyzed } : {}) },
          );
        } catch (error) {
          if (error instanceof OperationMismatchError) {
            const labels: Record<Operation, string> = {
              inquire: "询问",
              empathize: "共情",
              suggest: "暗示",
            };
            console.log(`\n[操作不匹配] 这句话更接近“${labels[error.detectedOperation]}”。`);
            console.log(error.explanation);
            if (state.forcedOperation) {
              playerText = await askPlayerLine("请改写为对伊莱感受的回应 > ");
              if (playerText === null) continue sessionLoop;
              continue;
            }
            const decision = await rl.question(
              `输入 1 改用“${labels[error.detectedOperation]}”并继续，输入 2 重新措辞（Esc 返回选择）> `,
            );
            if (decision === null) {
              console.log("已取消本次干预，本回合未消耗。");
              continue sessionLoop;
            }
            if (decision.trim() === "1") {
              operation = error.detectedOperation;
              preAnalyzed = error.analysis;
            } else {
              playerText = await askPlayerLine("重新输入你要说的话 > ");
              if (playerText === null) continue sessionLoop;
              preAnalyzed = undefined;
            }
            continue;
          }
          const stage = error instanceof ModelStageError && error.stage === "analyzer"
            ? "理解玩家输入"
            : "生成伊莱回答";
          const disclosureFailed = error instanceof Error && error.message.includes("narration_missing_clue:");
          console.error(disclosureFailed
            ? "\n伊莱的回答未能完整生成，本回合没有消耗，治疗记录保持不变。请重试。"
            : `\nDeepSeek 在“${stage}”阶段失败，本回合没有提交。`);
          if (debug) {
            console.error(`[DEBUG 模型错误] ${error instanceof Error ? error.message : String(error)}`);
          } else if (!disclosureFailed) {
            console.error("可运行 npm run diagnose:deepseek 检查 Key、余额、网络与 JSON 输出。使用 --debug 查看具体错误。 ");
          }
          modelFailed = true;
          break;
        }
      }
      if (modelFailed || !completed) continue;
      console.log("\n伊莱已经回应。 ");
      state = completed.resolution.state;
      const delivery = deliverAvailableMail(state);
      state = delivery.state;

      console.log(`\n伊莱：${completed.narration.spokenText}\n`);
      if (completed.resolution.newClues.length > 0) {
        console.log("治疗记录已更新。输入 /线索 可以查看。\n");
      } else if (
        operation === "inquire" &&
        !completed.resolution.changes.includes("inquiry_guarded_by_low_trust") &&
        !completed.resolution.changes.some((change) => change.startsWith("intervention_fatigue:"))
      ) {
        console.log("这次追问没有形成新的可记录事实；若不确定下一步，可输入 /建议。\n");
      }
      showVisibleState(state);
      showTurnEffects(completed.resolution.changes, state);
      for (const mail of delivery.delivered) {
        console.log(`\n新邮件：${mail.from}《${mail.subject}》（输入 /邮件 查看）`);
      }

      if (debug) {
        console.log("\n[DEBUG 分析器]");
        console.log(JSON.stringify(completed.analysis, null, 2));
        console.log("[DEBUG 规则结算]");
        console.log(JSON.stringify({
          accepted: completed.resolution.accepted,
          partial: completed.resolution.partial,
          acceptanceScore: completed.resolution.acceptanceScore,
          changes: completed.resolution.changes,
          errors: completed.resolution.errors,
          status: state.status,
          hidden: state.hidden,
          sources: state.sources,
          fallbacks: completed.fallbacks,
          diagnostics: completed.diagnostics,
        }, null, 2));
      }
    }

    if (state.ending) {
      const ending = endingSummary(state);
      console.log(`\n会话结局：${ending.title}\n\n${ending.text}`);
      while (true) {
        const choice = await rl.question("\n结局之后：1 揭开谜底（完整剧透） / 2 保留谜底并退出（默认；Esc 退出）> ");
        if (choice === null || ["", "2", "/退出"].includes(choice.trim())) break;
        if (choice.trim() !== "1") {
          console.log("输入 1 查看完整背景，或 2 保留谜底并退出。");
          continue;
        }
        console.log("\n以下为故事底稿，不是伊莱在本局中新说的话。空格或回车显示全文；Esc 停止并返回结局菜单。\n");
        await rl.typewrite(revealStory(state));
      }
    } else if (demo) {
      console.log("\n—— 三回合演示结束：伊莱似乎还有话没有说完。——");
    } else {
      console.log("\n—— 本次治疗会话结束。——");
    }
  } finally {
    rl.close();
  }
}
