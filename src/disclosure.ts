import type { NarratorOutput, NarratorRequest } from "./contracts.ts";

// Each group is a required fact anchor; alternatives allow natural paraphrases.
// These are disclosure checks, not a general semantic truth validator.
const anchors: Record<string, string[][]> = {
  orange_hands: [["指甲"], ["短"], ["指节", "关节"], ["旧伤", "伤痕", "疤"]],
  orange_never_turns: [["转身", "回头"], ["两下", "两声"], ["敲", "叩"]],
  orange_rain_radio: [["厨房"], ["雨"], ["站台广播", "车站广播", "站台的广播", "车站的广播"]],
  station_red_boots: [["红"], ["雨靴"], ["站台"], ["雨"]],
  station_waiting: [["等"], ["没来", "没出现", "没有出现", "没有来", "迟迟"], ["脚", "腿"], ["麻"]],
  station_wrong_size: [["雨靴", "靴子"], ["新"], ["不像自己的", "不像我的", "不属于我", "不是我的"]],
  glass_name: [["玻璃"], ["伊莱"], ["叫", "喊", "呼唤"]],
  glass_confirm: [["睁眼", "睁开眼"], ["确认", "听见", "听到"]],
  rooftop_recorder: [["录音机"], ["楼顶", "屋顶"], ["通风管"]],
  rooftop_lie: [["录音"], ["机构"], ["撒谎", "说谎", "欺骗"]],
  locked_room: [["窗"], ["外面", "外侧", "外头"], ["锁"]],
  locked_key: [["掌心", "手心", "手里"], ["钥匙"], ["想不起", "不知道", "不记得"]],
  blue_tie: [["会议", "开会"], ["蓝"], ["领带"], ["稿"], ["道歉"]],
  scripted_apology: [["道歉", "稿"], ["责任"], ["不"]],
  missed_call: [["电话"], ["没接", "没有接", "未接"], ["内疚", "自责", "愧疚"]],
  missing_caller: [["名字", "姓名", "是谁"], ["屏幕"], ["亮"], ["很久"]],
  three_answers: [["声音"], ["安慰"], ["追问"], ["接受"], ["选"]],
  practiced_smile: [["镜"], ["练"], ["笑"], ["放心"]],
  replace_pain: [["痛苦"], ["记忆"], ["换"], ["继续生活", "活下去"]],
  unstable_orange_ring: [["削橙", "剥橙"], ["左手"], ["银"], ["戒指"]],
  unstable_station_sign: [["站牌"], ["北岬"]],
  unstable_glass_sixth: [["玻璃"], ["第六次", "第6次"], ["确认"]],
};

export function disclosureRequirements(fragmentId: string, text: string): string[][] {
  return anchors[fragmentId] ?? [[text]];
}

export function validateDisclosure(narration: NarratorOutput, request: NarratorRequest): void {
  for (const clue of request.resolution.newClues) {
    if (!clue.requiredMentions.every((group) =>
      group.some((term) => narration.spokenText.includes(term))
    )) {
      throw new Error(`narration_missing_clue:${clue.fragmentId}`);
    }
  }
}
