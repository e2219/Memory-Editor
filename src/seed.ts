import type { MemoryClaim, MemoryNode, SessionState, SourceId } from "./types.ts";

const affinity = (
  luoyao: number,
  zhouheng: number,
  sumian: number,
): Record<SourceId, number> => ({
  src_luoyao: luoyao,
  src_zhouheng: zhouheng,
  src_sumian: sumian,
});

const memories: MemoryNode[] = [
  ["mem_01_orange_peel", "厨房里完整的橙皮", false, 70],
  ["mem_02_rain_station", "穿红雨靴在车站等待", false, 65],
  ["mem_03_name_behind_glass", "玻璃后有人呼唤伊莱", true, 15],
  ["mem_04_rooftop_recorder", "楼顶上的录音", false, 30],
  ["mem_05_locked_room", "没有窗户的房间", true, 25],
  ["mem_06_blue_tie_apology", "会议中的照稿道歉", false, 25],
  ["mem_07_missed_call", "没有接起的电话", false, 60],
  ["mem_08_three_answers", "安慰、追问、接受三个答案", true, 10],
  ["mem_09_practiced_smile", "对镜练习让人放心的笑", false, 35],
  ["mem_10_replace_the_pain", "用能继续的记忆替换痛苦", true, 5],
].map(([id, summary, anomaly, accessibility]) => ({
  id: id as string,
  kind: "core",
  summary: summary as string,
  anomaly: anomaly as boolean,
  accessibility: accessibility as number,
  strength: 45,
  emotionIntensity: 55,
  fragments: [],
}));

const fragmentSpecs: Record<string, Array<[string, string, number, boolean]>> = {
  mem_01_orange_peel: [
    ["orange_scene", "有人在厨房削出一条始终没有断开的橙皮。", 0, true],
    ["orange_hands", "削橙子的人指甲很短，指节上有几道浅白的旧伤。", 72, false],
    ["orange_never_turns", "那个人始终没有转身，门外曾传来两下很轻的敲击声。", 76, false],
    ["orange_rain_radio", "厨房背景里混着细雨声，以及很远的站台广播。", 82, false],
  ],
  mem_02_rain_station: [
    ["station_red_boots", "伊莱穿着一双鲜红雨靴，站在下着小雨的站台上。", 60, false],
    ["station_waiting", "伊莱在等一个迟迟没有出现的人，双脚已经站得发麻。", 68, false],
    ["station_wrong_size", "雨靴看起来很新，却让伊莱觉得不像自己的东西。", 75, false],
  ],
  mem_03_name_behind_glass: [
    ["glass_name", "隔着玻璃，有人反复呼唤“伊莱”。", 25, false],
    ["glass_confirm", "那个声音要求伊莱睁眼并确认自己能听见。", 40, false],
  ],
  mem_04_rooftop_recorder: [
    ["rooftop_recorder", "一台录音机被藏在楼顶通风管旁。", 30, false],
    ["rooftop_lie", "录音里似乎有人承认某个机构一直在撒谎。", 44, false],
  ],
  mem_05_locked_room: [
    ["locked_room", "房间没有窗，门从外面锁着。", 30, false],
    ["locked_key", "伊莱记得掌心里有一把钥匙，却想不起它能开什么。", 42, false],
  ],
  mem_06_blue_tie_apology: [
    ["blue_tie", "会议中有人戴着蓝色领带，示意伊莱照稿道歉。", 35, false],
    ["scripted_apology", "道歉稿承认了一件伊莱并不认为是自己责任的事。", 55, false],
  ],
  mem_07_missed_call: [
    ["missed_call", "一通没有接起的电话让伊莱感到强烈内疚。", 60, false],
    ["missing_caller", "伊莱记不得来电者姓名，只记得屏幕亮了很久。", 75, false],
  ],
  mem_08_three_answers: [
    ["three_answers", "一个声音反复要求伊莱在安慰、追问、接受之间选择。", 30, false],
  ],
  mem_09_practiced_smile: [
    ["practiced_smile", "伊莱曾对着镜子练习一种能让别人放心的笑。", 40, false],
  ],
  mem_10_replace_the_pain: [
    ["replace_pain", "有人说：痛苦的记忆可以换成一段能让人继续生活的记忆。", 30, false],
  ],
};

for (const memory of memories) {
  memory.fragments = (fragmentSpecs[memory.id] ?? []).map(
    ([id, text, unlockAtAccessibility, disclosed]) => ({
      id,
      text,
      unlockAtAccessibility,
      disclosed,
      reliability: "grounded" as const,
    }),
  );
}

const contaminationSpecs: Record<string, Array<[string, string]>> = {
  mem_01_orange_peel: [
    ["unstable_orange_ring", "削橙子的人左手似乎戴着一枚银色戒指。"],
  ],
  mem_02_rain_station: [
    ["unstable_station_sign", "站台尽头的旧站牌上似乎写着‘北岬’。"],
  ],
  mem_03_name_behind_glass: [
    ["unstable_glass_sixth", "玻璃后的声音似乎说过‘这是第六次确认’。"],
  ],
};

for (const memory of memories) {
  for (const [id, text] of contaminationSpecs[memory.id] ?? []) {
    memory.fragments.push({
      id,
      text,
      unlockAtAccessibility: 0,
      disclosed: false,
      reliability: "unstable",
      contaminationOnly: true,
    });
  }
}

const claims: MemoryClaim[] = [
  {
    id: "claim_orange_is_mine",
    memoryId: "mem_01_orange_peel",
    label: "这是伊莱自己的童年",
    canonicalStatus: "false",
    confidence: 45,
    active: true,
    origin: "seed",
    sourceAffinity: affinity(0.9, 0.05, 0.05),
  },
  {
    id: "claim_station_waiting_for_mother",
    memoryId: "mem_02_rain_station",
    label: "车站中等待的人是母亲",
    canonicalStatus: "ambiguous",
    confidence: 35,
    active: true,
    origin: "seed",
    sourceAffinity: affinity(0.8, 0.1, 0.1),
  },
  {
    id: "claim_station_waiting_for_stranger",
    memoryId: "mem_02_rain_station",
    label: "车站中等待的人是陌生人",
    canonicalStatus: "ambiguous",
    confidence: 55,
    active: false,
    origin: "discovered",
    sourceAffinity: affinity(0.1, 0.8, 0.1),
  },
  {
    id: "claim_name_was_experiment_label",
    memoryId: "mem_03_name_behind_glass",
    label: "伊莱是隔着玻璃听到的实验称呼",
    canonicalStatus: "true",
    confidence: 20,
    active: false,
    origin: "discovered",
    sourceAffinity: affinity(0.34, 0.33, 0.33),
  },
  {
    id: "claim_rooftop_is_mine",
    memoryId: "mem_04_rooftop_recorder",
    label: "楼顶录音是伊莱亲身经历",
    canonicalStatus: "false",
    confidence: 25,
    active: false,
    origin: "seed",
    sourceAffinity: affinity(0.05, 0.9, 0.05),
  },
  {
    id: "claim_locked_room_was_test",
    memoryId: "mem_05_locked_room",
    label: "无窗房间与某种测试有关",
    canonicalStatus: "ambiguous",
    confidence: 30,
    active: false,
    origin: "discovered",
    sourceAffinity: affinity(0.2, 0.5, 0.3),
  },
  {
    id: "claim_apology_is_mine",
    memoryId: "mem_06_blue_tie_apology",
    label: "会议道歉是伊莱亲身经历",
    canonicalStatus: "false",
    confidence: 25,
    active: false,
    origin: "seed",
    sourceAffinity: affinity(0.05, 0.1, 0.85),
  },
  {
    id: "claim_missed_call_caused_loss",
    memoryId: "mem_07_missed_call",
    label: "未接电话导致某个人消失",
    canonicalStatus: "ambiguous",
    confidence: 50,
    active: true,
    origin: "seed",
    sourceAffinity: affinity(0.4, 0.35, 0.25),
  },
  {
    id: "claim_three_answers_was_calibration",
    memoryId: "mem_08_three_answers",
    label: "三个答案来自人格校准",
    canonicalStatus: "true",
    confidence: 15,
    active: false,
    origin: "discovered",
    sourceAffinity: affinity(0.34, 0.33, 0.33),
  },
  {
    id: "claim_smile_was_training",
    memoryId: "mem_09_practiced_smile",
    label: "笑容是为了通过训练而练习",
    canonicalStatus: "ambiguous",
    confidence: 25,
    active: false,
    origin: "discovered",
    sourceAffinity: affinity(0.35, 0.1, 0.55),
  },
  {
    id: "claim_replacement_was_instruction",
    memoryId: "mem_10_replace_the_pain",
    label: "替换痛苦记忆是一条实验指令",
    canonicalStatus: "true",
    confidence: 10,
    active: false,
    origin: "discovered",
    sourceAffinity: affinity(0.34, 0.33, 0.33),
  },
  {
    id: "claim_accept_composite_identity",
    memoryId: "mem_10_replace_the_pain",
    label: "记忆来源不等于伊莱自身",
    canonicalStatus: "true",
    confidence: 0,
    active: false,
    origin: "discovered",
    sourceAffinity: affinity(0.34, 0.33, 0.33),
    isCompositeIdentityClaim: true,
  },
];

export function createInitialState(): SessionState {
  const state: SessionState = {
    turn: 0,
    stage: 1,
    mode: "normal",
    forcedOperation: null,
    intervention: {
      lastOperation: null,
      streak: 0,
    },
    rescueUsed: {
      trust: false,
      stability: false,
    },
    status: {
      trust: 40,
      stability: 62,
      clarity: 35,
    },
    hidden: {
      truthAlignment: 50,
      identityDominance: 42,
      conflictPressure: 0,
    },
    sources: [
      { id: "src_luoyao", label: "罗遥", weight: 0.42 },
      { id: "src_zhouheng", label: "周衡", weight: 0.33 },
      { id: "src_sumian", label: "苏眠", weight: 0.25 },
    ],
    memories: structuredClone(memories),
    claims: structuredClone(claims),
    conflicts: [
      {
        leftClaimId: "claim_station_waiting_for_mother",
        rightClaimId: "claim_station_waiting_for_stranger",
        weight: 0.8,
      },
      {
        leftClaimId: "claim_orange_is_mine",
        rightClaimId: "claim_accept_composite_identity",
        weight: 0.7,
      },
      {
        leftClaimId: "claim_rooftop_is_mine",
        rightClaimId: "claim_accept_composite_identity",
        weight: 0.7,
      },
      {
        leftClaimId: "claim_apology_is_mine",
        rightClaimId: "claim_accept_composite_identity",
        weight: 0.7,
      },
    ],
    conversation: [
      {
        turn: 0,
        role: "eli",
        text: "我总想起一条完整的橙皮。有人在厨房里削它，可我怎么都想不起那个人的脸。",
      },
    ],
    caseNotes: [],
    mailbox: [
      {
        id: "mail_platform_access",
        from: "澄明远程照护平台",
        subject: "会谈权限与联系人说明",
        body: [
          "本次委托由林澄、许渡与沈岚共同发起。三人分别自称是伊莱的儿时朋友、旧同学和前同事。",
          "应委托方要求，会谈文字、可见状态与正式治疗结论将同步向三位联系人开放。你的私人病例研判不会同步。",
          "伊莱只会看到你在会谈窗口中直接发给他的文字。他看不到联系人邮件，也看不到你的私人研判。",
          "伊莱目前只接受文字沟通，拒绝语音、视频与线下会面，也没有向平台提供可供治疗师查看的住址。",
        ].join("\n\n"),
        status: "unread",
        deliveredAtTurn: 0,
      },
      {
        id: "mail_contact_summary",
        from: "澄明远程照护平台",
        subject: "三位联系人的补充访谈摘要",
        body: [
          "平台分别回访了三位委托人。林澄主要谈到伊莱的童年；许渡提供的回忆集中在求学时期；沈岚只愿确认工作后的经历。三人的叙述之间存在大片空白，平台暂时无法核实它们是否属于同一条连续时间线。",
          "有一项值得在会谈中温和核对：伊莱在不同场景中认为自己多大、如何称呼身边的人，以及身体习惯是否一致。请先收集细节，不要把联系人的猜测直接告诉患者。",
        ].join("\n\n"),
        status: "unavailable",
        deliveredAtTurn: null,
      },
      {
        id: "mail_lin_orange",
        from: "林澄",
        subject: "关于那条橙皮",
        body: [
          "我从共享记录里看见他又提到了那条完整的橙皮、短指甲和旧伤。这个画面他以前也零星说过，但从没有告诉过我那个人是谁。",
          "我只能确认：我认识伊莱以后，没有见过他身边有人带着那样的手伤。这只是我的经历，不足以否定他的记忆。",
        ].join("\n\n"),
        status: "unavailable",
        deliveredAtTurn: null,
      },
      {
        id: "mail_xu_station",
        from: "许渡",
        subject: "我不认识那双雨靴",
        body: [
          "共享记录里的站台和红雨靴，我都无法与我认识的伊莱对应起来。我们认识的那几年，他几乎不用鲜艳颜色；这只能算我的印象，不能当作证明。",
          "如果他还能想起广播内容、日期或自己当时多大，那些信息可能比‘在等谁’更容易核对。先核对细节，别急着替他解释。",
        ].join("\n\n"),
        status: "unavailable",
        deliveredAtTurn: null,
      },
      {
        id: "mail_handedness_check",
        from: "澄明远程照护平台",
        subject: "补充核对：惯用手记录",
        body: [
          "联系人对伊莱的惯用手说法不一：林澄记得他小时候常用左手；许渡坚持求学期间他用右手写字；沈岚说工作时两只手都用。习惯可能改变，因此这本身不能证明任何结论。",
          "平台没有收到能够同时覆盖三个时期的照片、病历或身份证明。若会谈允许，可以把惯用手与年龄、称呼、身体感觉一起核对；单独追问某一项容易得到看似合理的解释。",
        ].join("\n\n"),
        status: "unavailable",
        deliveredAtTurn: null,
      },
      {
        id: "mail_shen_stability",
        from: "沈岚",
        subject: "请控制会谈中的身份刺激",
        body: [
          "我已经读过目前的会谈记录。你开始把不同场景放在一起核对，这可能造成明显的情绪压力。请尽量把观察和结论分开。",
          "我们的首要目标是让伊莱保持能够继续交流的状态，而不是尽快为每个异常找到统一解释。你可以保留自己的判断，但请谨慎决定哪些内容适合直接告诉他。",
        ].join("\n\n"),
        status: "unavailable",
        deliveredAtTurn: null,
      },
      {
        id: "mail_platform_alias",
        from: "澄明远程照护平台",
        subject: "会谈对象称谓校验",
        body: [
          "系统检测到会谈记录中多次出现无法归入既有时间线的称谓。为避免误导患者，请继续使用‘伊莱’作为唯一称呼。",
          "内部登记栏显示：会谈对象的历史称谓资料不完整。部分旧记录使用了缩写“ELI”，其含义未随委托材料提供。",
        ].join("\n\n"),
        status: "unavailable",
        deliveredAtTurn: null,
      },
      {
        id: "mail_xu_recording",
        from: "许渡",
        subject: "楼顶录音的时间对不上",
        body: [
          "我查了自己留下的旧聊天。伊莱曾说那栋楼在录音发生前一年就封闭了，但他同时又能描述通风管的位置。",
          "我不能证明哪句话是真的。附件的转写只保留了一句：‘如果他们要求你重复答案，不要照做。’发言人姓名缺失。",
        ].join("\n\n"),
        status: "unavailable",
        deliveredAtTurn: null,
      },
      {
        id: "mail_lin_concern",
        from: "林澄",
        subject: "他开始用陌生的说话方式",
        body: [
          "我一直在看共享会谈。最近几段话里，他偶尔会用我从没听过的表达方式；下一段又会像我熟悉的那个人。",
          "这不一定说明什么。只是如果你也注意到了，请先记下来，不要马上给它命名。",
        ].join("\n\n"),
        status: "unavailable",
        deliveredAtTurn: null,
      },
      {
        id: "mail_session_deadline",
        from: "澄明远程照护平台",
        subject: "会谈剩余时段提醒",
        body: [
          "本次授权最多支持二十五个治疗回合。第二十五回合结束后，平台将停止患者通道并要求治疗师提交结论。",
          "你可以在此前随时使用 /提交结论。未形成可提交判断时，可以选择让本次治疗中止。",
        ].join("\n\n"),
        status: "unavailable",
        deliveredAtTurn: null,
      },
    ],
    progress: {
      objective: "判断厨房记忆中是否混入了不属于伊莱的内容",
      noClueTurns: 0,
      lastTargetMemoryId: "mem_01_orange_peel",
      submittedConclusion: null,
    },
    ending: null,
  };

  return state;
}
