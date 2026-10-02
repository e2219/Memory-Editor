"use strict";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const names = { inquire: "询问", empathize: "共情", suggest: "暗示" };
const operationHelp = {
  inquire: "从已经出现的细节问起，不必急着给答案。",
  empathize: "回应他已经表达的感受，给回忆一点空间。",
  suggest: "提出一种未经证实的解释，它可能改变他的记忆。",
};
let state = null, currentTab = "chat", operation = "inquire", busy = false;
let serverInfo = { byok: true, invites: false };
let toastTimer, revealTimer, pollTimer, audioContext = null, soundOn = false;
const storage = {
  get(key) { try { return localStorage.getItem(key) || ""; } catch { return ""; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
};
let outbox = null;
try { outbox = JSON.parse(storage.get("memory-outbox") || "null"); } catch {}
const requestId = () => crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) => v.toString(16).padStart(2, "0")).join("");

function toast(message, long = false) {
  clearTimeout(toastTimer); $("#toast").textContent = message; $("#toast").hidden = false;
  toastTimer = setTimeout(() => { $("#toast").hidden = true; }, long ? 8000 : 4200);
}
async function api(path, body) {
  let response;
  try {
    response = await fetch(`/api/${path}`, {
      method: body === undefined ? "GET" : "POST", credentials: "same-origin",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch { throw { error: "连接中断，草稿仍在。请检查网络后重试。", network: true }; }
  let result;
  try { result = await response.json(); }
  catch { throw { error: "暂时无法连接会谈服务，请联系邀请人确认电脑和分享入口仍在运行。", network: true }; }
  if (!response.ok) throw { ...result, status: response.status };
  return result;
}
function rememberOutbox(value) {
  outbox = value;
  if (value) storage.set("memory-outbox", JSON.stringify(value)); else storage.remove("memory-outbox");
  $("#retry-row").hidden = !value;
}
function acceptState(next, scroll = false) {
  const previousUnread = state?.mailbox.filter((m) => m.status === "unread").length ?? 0;
  state = next;
  if (outbox && next.lastRequestId === outbox.requestId) {
    rememberOutbox(null); $("#player-text").value = ""; storage.remove("memory-draft");
  }
  if (state.forcedOperation) operation = state.forcedOperation;
  render(scroll);
  if (state.mailbox.filter((m) => m.status === "unread").length > previousUnread && state.turn > 0) toast("收到一封新邮件。你可以稍后再看。");
  if (next.busy) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => sync().catch(() => {}), 2500);
  }
}
async function sync() { acceptState(await api("session")); }
function showWorkspace() { $("#welcome").hidden = true; $("#workspace").hidden = false; }

function setOperation(value) { operation = state?.forcedOperation || value; renderControls(); }
function setTab(tab) {
  currentTab = tab;
  for (const name of ["chat", "mail", "clues", "notes"]) $(`#${name}-panel`).hidden = name !== tab;
  $$("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  renderControls();
}
function renderControls() {
  if (!state) return;
  const waiting = busy || state.busy;
  const closed = !!state.ending || state.turn >= 25;
  $("#composer").hidden = currentTab !== "chat" || closed;
  $("#thinking").hidden = !waiting;
  $$("[data-operation]").forEach((button) => {
    const active = button.dataset.operation === operation;
    button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
    button.disabled = !!waiting || (!!state.forcedOperation && button.dataset.operation !== state.forcedOperation);
  });
  $("#operation-help").textContent = operationHelp[operation];
  $("#send-button").disabled = !!waiting || closed;
  $("#player-text").disabled = !!waiting || closed;
  $("#send-button").textContent = waiting ? "回应中…" : "发送 ↑";
  $("#end-button").disabled = !!waiting;
  $("#note-form").hidden = !!state.ending;
  $("#note-form button[type=submit]").disabled = !!waiting;
  $("#retry-row").hidden = !outbox;
  $("#retry-button").disabled = !!waiting;
  $("#end-button").textContent = state.ending ? "结局" : "结案";
}
function render(scroll = false) {
  if (!state) return;
  const wasBottom = $("#chat-scroll").scrollHeight - $("#chat-scroll").scrollTop - $("#chat-scroll").clientHeight < 100;
  $("#session-caption").textContent = state.ending ? "会谈已归档 · 可回看记录" : state.mode === "离线演示" ? "离线演示 · 不代表在线对话表现" : "文字会谈 · 已自动保存";
  $("#account-status").textContent = state.credentialRequired ? "需要补充 API 凭据才能继续对话" : state.credentialKind === "byok" ? "使用你的 API · Key 仅暂存内存" : state.credentialKind === "invite" ? "邀请码代付 · 一码一局" : "离线演示";
  $("#round-label").textContent = `已交流 ${state.turn} / ${state.maxTurns} 回合`;
  for (const key of ["trust", "stability", "clarity"]) {
    const value = state.status[key];
    const label = key === "trust" ? (value < 20 ? "关系危机" : value < 25 ? "戒备" : value < 70 ? "有限信任" : "开放")
      : key === "stability" ? (value < 20 ? "崩溃" : value < 40 ? "失稳" : value < 70 ? "可维持" : "稳定")
      : (value < 20 ? "记忆融合" : value < 40 ? "碎片化" : value < 70 ? "可辨认" : "清醒");
    const bar = $(`#${key}-bar`);
    bar.innerHTML = Array.from({ length: 10 }, (_, i) => `<i${i < Math.round(value / 10) ? ' class="on"' : ""}></i>`).join("");
    bar.classList.toggle("warning", value < (key === "stability" ? 40 : 25));
    bar.setAttribute("aria-label", label); $(`#${key}-label`).textContent = label;
  }
  $("#crisis-banner").hidden = state.crisis === "normal" && state.turn < 25;
  $("#crisis-banner").textContent = state.turn >= 25 ? "本次交流时段已结束。仍可整理资料，然后提交结论或暂不定论。"
    : state.crisis === "rupture" ? "伊莱已不愿继续被追问。下一次交流只能尝试共情修复。" : "伊莱现在无法承受更多追问。请先用共情帮助他恢复。";
  $("#messages").replaceChildren(...state.conversation.map((message) => {
    const article = document.createElement("article");
    article.className = `message ${message.role}`; article.dataset.turn = message.turn; article.dataset.role = message.role;
    const meta = document.createElement("div"); meta.className = "message-meta";
    meta.textContent = message.role === "eli" ? "伊莱" : "你 · 治疗师";
    const body = document.createElement("div"); body.className = "message-body"; body.textContent = message.text;
    article.append(meta, body); return article;
  }));
  const unread = state.mailbox.filter((m) => m.status === "unread").length;
  $("#mail-badge").hidden = !unread; $("#mail-badge").textContent = unread;
  $("#mail-list").innerHTML = state.mailbox.map((mail) => `<article class="mail-card ${mail.status === "unread" ? "unread" : ""}"><div class="meta"><span>${escapeHTML(mail.from)}</span><span>${({ unread: "未读", read: "已读", ignored: "已忽略" })[mail.status]}</span></div><h3>${escapeHTML(mail.subject)}</h3><div class="mail-actions"><button class="text-button" data-ignore-mail="${escapeHTML(mail.id)}">暂时忽略</button><button class="quiet-button" data-open-mail="${escapeHTML(mail.id)}">阅读来信 ↗</button></div></article>`).join("");
  $("#clue-list").innerHTML = state.clues.map((clue) => `<article class="clue-card ${clue.reliability !== "grounded" ? "uncertain" : ""}"><div class="meta"><span>${clue.reliability === "unstable" ? "◇ 失稳时出现 · 尚未复核" : clue.reliability === "player_influenced" ? "△ 受你的暗示影响" : "会谈中提及"}</span></div><p>${escapeHTML(clue.text)}</p>${Number.isInteger(clue.turn) ? `<button class="text-button" data-jump-turn="${clue.turn}">回到这段会谈 ↗</button>` : ""}</article>`).join("");
  $("#note-list").innerHTML = state.notes.length ? state.notes.slice().reverse().map((note) => `<article class="note-card"><div class="meta"><span>私人研判</span><span>第 ${note.createdAtTurn} 回合后</span></div><p>${escapeHTML(note.text)}</p></article>`).join("") : '<p class="empty-state">还没有写下判断。你可以先听伊莱说，也可以随时回来记录一个疑点。</p>';
  $("#ending-card").hidden = !state.ending;
  if (state.ending) $("#ending-card").innerHTML = `<p class="eyebrow">本次会谈 · 已结束</p><h2>${escapeHTML(state.ending.title)}</h2><div class="ending-text">${escapeHTML(state.ending.text)}</div><div class="form-actions"><button id="reveal-button" class="primary">选择查看完整背景</button><button id="keep-mystery" class="quiet-button">保留谜底</button></div>`;
  renderControls();
  if (scroll || wasBottom) requestAnimationFrame(() => { $("#chat-scroll").scrollTop = $("#chat-scroll").scrollHeight; });
}
function dialog(title, html, eyebrow = "会谈工具") {
  clearTimeout(revealTimer);
  $("#modal-title").textContent = title; $("#modal-body").innerHTML = html; $("#modal-eyebrow").textContent = eyebrow;
  if (!$("#modal").open) $("#modal").showModal();
  $("#modal").scrollTop = 0;
}
function closeDialog() { clearTimeout(revealTimer); $("#modal").close(); }
$("#close-modal").addEventListener("click", closeDialog);
$("#modal").addEventListener("close", () => clearTimeout(revealTimer));
$("#modal").addEventListener("click", (event) => { if (event.target === $("#modal")) { const r = $("#modal").getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeDialog(); } });

function briefing() {
  // Keep the inquiry exception separate from the unchanged general fatigue rule.
  dialog("先了解这场委托", '<p>林澄、许渡、沈岚共同委托你帮助伊莱。他们分别自称是他的儿时朋友、旧同学和前同事。伊莱只接受文字交流，目前拒绝语音、视频与线下会面。</p><h3>什么会被看见</h3><p>三位联系人可以阅读会谈与正式结论，并发来邮件。伊莱看不到邮件或私人研判；私人研判也不向联系人共享。</p><h3>这场会谈何时结束</h3><p>最多 25 个治疗回合。你可以在结案条件满足后提交解释，也可以在至少一次交流后选择“暂不定论”。两类危机各有一次共情挽救机会，再次发生同类危机可能中止会谈。</p><h3>三种说话方式</h3><p>询问：中立核对细节，让记忆更清晰。\n共情：回应感受，帮助恢复信任与稳定。\n暗示：提供未经证实的解释，可能改变记忆。\n同一种方式连续第三次使用会产生疲劳。</p><h3>状态的影响</h3><p>低信任可能阻止敏感追问；低稳定可能带来尚未复核的细节；低清晰会让伊莱更容易接受暗示。线索页会标出不可靠信息，但不会替你给出答案。</p><p>阅读资料与记录研判不消耗回合。关闭弹窗可返回；已发送的对话不能撤回。结局后的完整背景由你自行决定是否查看。</p>', "委托背景与规则");
  const inquiryRule = document.createElement("p");
  inquiryRule.textContent = "询问的信任扣减从连续第六次才开始；前五次不扣信任。切换共情或暗示会重新计数，但第三次起的疲劳仍会影响线索获取与稳定。";
  $("#modal-body").append(inquiryRule);
}
async function mutate(path, values, id = requestId()) {
  if (busy || state.busy) throw { error: "伊莱正在回应，请稍候。" };
  const result = await api(path, { ...values, revision: state.revision, requestId: id });
  acceptState(result); return result;
}
async function handleError(error) {
  if (error.status === 428) { state.credentialRequired = true; render(); accountDialog(); return; }
  if (error.refresh || error.busy) { try { await sync(); } catch {} }
  if (error.status === 401) toast("会话已过期。刷新页面后重新输入测试口令。", true);
  else toast(error.error || "操作未完成，请稍后重试。", true);
}
async function sendTurn(payload) {
  if (busy || state.busy) return;
  rememberOutbox(payload); busy = true; renderControls();
  try {
    const result = await api("turn", payload);
    rememberOutbox(null); $("#player-text").value = ""; storage.remove("memory-draft");
    acceptState(result, true);
  } catch (error) {
    if (error.detectedOperation) {
      dialog("这句话更接近另一种方式", `<p>${escapeHTML(error.error)}</p><p>本回合还没有提交。你可以改用“${names[error.detectedOperation]}”，也可以返回修改这句话。</p><div class="modal-actions"><button id="rewrite-button" class="quiet-button">返回修改</button><button id="switch-operation" class="primary">改用${names[error.detectedOperation]}并发送</button></div>`);
      $("#rewrite-button").onclick = () => { rememberOutbox(null); closeDialog(); $("#player-text").focus(); };
      $("#switch-operation").onclick = () => { operation = error.detectedOperation; closeDialog(); sendTurn({ ...payload, operation }); };
    } else {
      await handleError(error);
      if (error.refresh && outbox && outbox.revision !== state.revision) rememberOutbox(null);
      if (error.network || error.refresh || error.busy) { try { await sync(); } catch {} }
    }
  } finally { busy = false; renderControls(); }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = $("button", event.currentTarget); button.disabled = true;
  $("#login-error").textContent = "";
  const kind = $("#login-kind").value;
  const payload = kind === "byok" ? { kind, apiKey: $("#access-code").value } : kind === "invite" ? { kind, code: $("#access-code").value } : { code: $("#access-code").value };
  try { acceptState(await api("login", payload), true); showWorkspace(); briefing(); }
  catch (error) { $("#login-error").textContent = error.error || "无法进入，请稍后重试。"; }
  finally { $("#access-code").value = ""; button.disabled = false; }
});
function updateLoginKind() {
  const kind = $("#login-kind").value;
  const byok = kind === "byok";
  $("#credential-label").textContent = byok ? "DeepSeek API Key（不是网页版账号密码）" : kind === "invite" ? "邀请人提供的独立邀请码" : "离线演示口令";
  $("#access-code").placeholder = byok ? "DeepSeek API Key" : "邀请码 / 演示口令";
  $("#access-code").minLength = byok ? 16 : 8;
  $("#access-code").value = "";
  $("#credential-notice").hidden = !byok;
  $("#credential-consent").checked = false;
}
$("#login-kind").onchange = updateLoginKind;
function accountDialog() {
  dialog("API 使用与会话", `<p>当前方式：${state.credentialKind === "byok" ? "使用自己的 Key" : state.credentialKind === "invite" ? "邀请人代付" : "旧会话 / 离线演示"}。邀请码不要共用，同码可读取同一局。</p>${state.credentialKind === "byok" ? '<form id="key-form"><label for="replacement-key">重新输入你的 DeepSeek API Key（仅发送给可信的本站服务端）</label><input id="replacement-key" type="password" autocomplete="off" required minlength="16" maxlength="256"><button class="primary" type="submit">更新 Key，继续原局</button></form>' : ""}<p>退出会从服务内存释放你的 Key；会谈存档仍保留。自带 Key 的会话退出后目前无法找回，请优先更新 Key 继续原局。</p><button id="logout-button" class="quiet-button">退出并清除本机草稿</button>`);
  if ($("#key-form")) $("#key-form").onsubmit = async (event) => {
    event.preventDefault(); const input = $("#replacement-key"); const button = $("button", event.target); button.disabled = true;
    try { acceptState(await api("credentials", { apiKey: input.value })); closeDialog(); toast("已更新凭据，可继续原局。"); }
    catch (error) { toast(error.error || "更新失败。"); }
    finally { input.value = ""; button.disabled = false; }
  };
  $("#logout-button").onclick = async () => {
    try {
      await api("logout", {}); clearTimeout(pollTimer); rememberOutbox(null);
      storage.remove("memory-draft"); storage.remove("memory-note-draft");
      $("#player-text").value = ""; $("#note-text").value = "";
      closeDialog(); state = null; $("#workspace").hidden = true; $("#welcome").hidden = false;
    } catch (error) { toast(error.error || "退出失败。"); }
  };
}
$("#account-button").onclick = accountDialog;
$("#talk-form").addEventListener("submit", (event) => {
  event.preventDefault(); const text = $("#player-text").value.trim();
  if (!text) return toast("先写下一句想对伊莱说的话。");
  const matching = outbox?.text === text && outbox?.operation === operation;
  sendTurn(matching ? outbox : { requestId: requestId(), revision: state.revision, text, operation });
});
$("#player-text").value = storage.get("memory-draft");
$("#player-text").addEventListener("input", (event) => storage.set("memory-draft", event.target.value));
$("#player-text").addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); $("#talk-form").requestSubmit(); } });
$("#retry-button").onclick = async () => { try { await sync(); if (outbox && !state.busy) { if (outbox.revision !== state.revision) { rememberOutbox(null); toast("记录已更新，草稿已保留。请确认后重新发送。"); } else sendTurn(outbox); } } catch (error) { handleError(error); } };
$("#discard-button").onclick = () => { rememberOutbox(null); toast("已保留草稿，发送前可继续修改。"); };
$$("[data-operation]").forEach((button) => button.onclick = () => setOperation(button.dataset.operation));
$$("[data-tab]").forEach((button) => button.onclick = () => setTab(button.dataset.tab));
$("#help-button").onclick = briefing; $("#brief-button").onclick = briefing;
$("#note-text").value = storage.get("memory-note-draft");
$("#note-text").oninput = (event) => storage.set("memory-note-draft", event.target.value);
$("#clear-note").onclick = () => { $("#note-text").value = ""; storage.remove("memory-note-draft"); };
$("#note-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const text = $("#note-text").value.trim();
  if (!text) return toast("写下一个疑点，再保存研判。");
  try { await mutate("note", { text }); $("#note-text").value = ""; storage.remove("memory-note-draft"); toast("已保存到私人研判。"); }
  catch (error) { handleError(error); }
});
$("#mail-list").addEventListener("click", async (event) => {
  const open = event.target.closest("[data-open-mail]"); const ignore = event.target.closest("[data-ignore-mail]");
  if (!open && !ignore) return;
  const mailId = open?.dataset.openMail || ignore.dataset.ignoreMail;
  try {
    const existing = state.mailbox.find((m) => m.id === mailId);
    if (!open || !existing.body) await mutate("mail", { mailId, status: open ? "read" : "ignored" });
    if (open) { const mail = state.mailbox.find((m) => m.id === mailId); dialog(mail.subject, `<p>${escapeHTML(mail.body)}</p>`, mail.from); }
    else toast("已暂时忽略，仍可稍后阅读。");
  } catch (error) { handleError(error); }
});
$("#clue-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-jump-turn]"); if (!button) return;
  setTab("chat"); const message = $(`[data-role="eli"][data-turn="${Number(button.dataset.jumpTurn)}"]`);
  if (message) { message.scrollIntoView({ block: "center", behavior: "smooth" }); message.classList.add("highlight"); setTimeout(() => message.classList.remove("highlight"), 2200); }
});
$("#hint-button").onclick = () => {
  const known = new Set(state.clues.filter((c) => c.reliability === "grounded").map((c) => c.id));
  const direction = known.has("station_waiting") ? "可以先问清站台上的身体感觉，再决定是否核对其他场景。记不起来本身不等于撒谎。"
    : known.has("orange_rain_radio") ? "可以核对厨房画面与广播的先后关系。先听他的描述，再决定这些细节能否放在一起。"
    : known.has("orange_hands") ? "可以沿已出现的手部特征、动作或周围声音继续询问，不急着指定那个人的身份。"
    : "可以从削橙子那个人的手或动作问起。问题越具体，越容易判断哪些细节真的出现过。";
  dialog("先从一个具体细节开始", `<p>${direction}</p><p>如果刚刚连续追问，先回应伊莱已经表达的感受。也可以暂时停下，读一封邮件，或记录你尚未确定的解释。</p>`, "可选的会谈方向");
};
function concludeDialog(text = "", disposition = "defer") {
  if (state.ending) { setTab("chat"); $("#ending-card").scrollIntoView({ block: "center" }); return; }
  dialog("你希望把会谈停在哪里？", `<p>结案后不能继续患者对话。你不必查清所有秘密，也可以明确保留不确定性。</p><form id="conclusion-form"><label class="modal-option"><input type="radio" name="disposition" value="defer" ${disposition === "defer" ? "checked" : ""}><span>暂不定论<small>保留疑点，结束本次治疗。</small></span></label><label class="modal-option"><input type="radio" name="disposition" value="interpret" ${disposition === "interpret" ? "checked" : ""}><span>提交治疗解释<small>写下你的判断与处置建议。</small></span></label>${state.turn >= 25 ? '<label class="modal-option"><input type="radio" name="disposition" value="stop"><span>无法形成结论<small>以治疗中止结束本次会谈。</small></span></label>' : ""}<label for="conclusion-text">你的判断、疑点或暂缓理由</label><textarea id="conclusion-text" rows="4" maxlength="1200">${escapeHTML(text)}</textarea><div class="modal-actions"><button id="back-to-session" type="button" class="quiet-button">继续整理</button><button type="submit" class="primary">查看提交内容</button></div></form>`, "结案前 · 可以返回");
  $("#back-to-session").onclick = closeDialog;
  $("#conclusion-form").onsubmit = (event) => {
    event.preventDefault(); const disposition = new FormData(event.target).get("disposition"); const text = $("#conclusion-text").value.trim();
    if (!text && disposition !== "stop") return toast("请写下你的判断或暂缓理由。");
    dialog("确认结束本次会谈？", `<p>${escapeHTML(({ defer: "暂不定论", interpret: "提交治疗解释", stop: "无法形成结论" })[disposition])}</p><p>${escapeHTML(text || "不提交正式结论。")}</p><p>确认后将显示本局结局。是否查看完整故事背景，由你在结局后自行选择。</p><div class="modal-actions"><button id="edit-conclusion" class="quiet-button">返回修改</button><button id="confirm-conclusion" class="primary">确认结束会谈</button></div>`, "最后确认");
    $("#edit-conclusion").onclick = () => concludeDialog(text, disposition);
    $("#confirm-conclusion").onclick = async () => {
      $("#confirm-conclusion").disabled = true;
      try { await mutate("conclude", { text, disposition, confirm: true }); closeDialog(); setTab("chat"); $("#ending-card").scrollIntoView({ block: "center" }); }
      catch (error) { handleError(error); if ($("#confirm-conclusion")) $("#confirm-conclusion").disabled = false; }
    };
  };
}
$("#end-button").onclick = () => concludeDialog();
$("#ending-card").addEventListener("click", (event) => {
  if (event.target.closest("#keep-mystery")) return toast("谜底已保留。你可以留在这里回看记录，也可以关闭页面。");
  if (!event.target.closest("#reveal-button")) return;
  dialog("揭开这场委托的完整背景？", '<p>接下来的文字包含完整剧透，也会解释你可能尚未发现的部分。它不会改变本局结局，也不会发送给伊莱。</p><div class="modal-actions"><button id="cancel-reveal" class="quiet-button">保留谜底</button><button id="confirm-reveal" class="primary">揭开谜底</button></div>', "仅供玩家阅读");
  $("#cancel-reveal").onclick = closeDialog;
  $("#confirm-reveal").onclick = async () => {
    $("#confirm-reveal").disabled = true;
    try {
      const result = await api("reveal", {});
      dialog("谜底 · 记忆背后的事", '<div class="modal-actions"><button id="reveal-pause" class="quiet-button">暂停</button><button id="reveal-all" class="quiet-button">显示全文</button></div><div id="reveal-copy" class="reveal-copy"></div>', "完整背景 · 不改变本局结局");
      const characters = Array.from(result.text); let i = 0, paused = false;
      const output = $("#reveal-copy");
      const tick = () => { if (!$("#modal").open || paused) return; output.append(document.createTextNode(characters.slice(i, i + 2).join(""))); i += 2; if (i < characters.length) revealTimer = setTimeout(tick, 30); else $("#reveal-pause").disabled = true; };
      $("#reveal-pause").onclick = () => { paused = !paused; clearTimeout(revealTimer); $("#reveal-pause").textContent = paused ? "继续" : "暂停"; if (!paused) tick(); };
      $("#reveal-all").onclick = () => { clearTimeout(revealTimer); i = characters.length; output.textContent = result.text; $("#reveal-pause").disabled = true; };
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) $("#reveal-all").click(); else tick();
    } catch (error) { handleError(error); if ($("#confirm-reveal")) $("#confirm-reveal").disabled = false; }
  };
});

async function toggleSound() {
  if (soundOn) { await audioContext?.close(); audioContext = null; soundOn = false; }
  else {
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      audioContext = new Audio(); await audioContext.resume();
      const buffer = audioContext.createBuffer(1, audioContext.sampleRate * 8, audioContext.sampleRate);
      const samples = buffer.getChannelData(0); let previous = 0;
      for (let i = 0; i < samples.length; i++) { previous = (previous + .02 * (Math.random() * 2 - 1)) / 1.02; samples[i] = previous * 3; }
      const source = audioContext.createBufferSource(); source.buffer = buffer; source.loop = true;
      const filter = audioContext.createBiquadFilter(); filter.type = "lowpass"; filter.frequency.value = 380;
      const gain = audioContext.createGain(); gain.gain.value = .055;
      source.connect(filter).connect(gain).connect(audioContext.destination); source.start(); soundOn = true;
    } catch { audioContext?.close(); audioContext = null; return toast("当前浏览器暂不支持环境声，仍可安静阅读。"); }
  }
  $("#sound-toggle").textContent = soundOn ? "♬" : "♫";
  $("#sound-toggle").setAttribute("aria-label", soundOn ? "关闭环境声" : "开启环境声");
  toast(soundOn ? "已开启轻环境声，可用手机音量键调低。" : "环境声已关闭。");
}
$("#sound-toggle").onclick = toggleSound;
document.addEventListener("visibilitychange", () => { if (document.hidden && soundOn) toggleSound(); if (!document.hidden && state && !busy) sync().catch(() => {}); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("#modal").open && !busy && currentTab !== "chat") setTab("chat"); });
window.addEventListener("online", () => { if (state && !busy) sync().catch(() => {}); });
if (window.visualViewport) {
  const resize = () => document.documentElement.style.setProperty("--app-height", `${window.visualViewport.height}px`);
  window.visualViewport.addEventListener("resize", resize); resize();
}
(async () => {
  try {
    serverInfo = await api("info"); $("#connection-mode").textContent = serverInfo.mode === "离线演示" ? "离线演示" : "在线会谈";
    if (!serverInfo.byok) $("#login-kind").innerHTML = '<option value="mock">离线演示（固定模板，不调用 API）</option>';
    else $("#login-kind option[value=invite]").disabled = !serverInfo.invites;
    updateLoginKind();
  }
  catch { $("#connection-mode").textContent = "暂时无法连接"; }
  try { acceptState(await api("session"), true); showWorkspace(); }
  catch (error) { if (error.status !== 401) $("#login-error").textContent = error.error; }
})();
