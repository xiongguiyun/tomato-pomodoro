/* ============ 🍅 番茄钟 主逻辑 ============ */
"use strict";

/* ---------- 工具 ---------- */
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function fmtDur(min) {
  min = Math.round(min);
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}小时${m}分` : `${h}小时`;
}

/* ---------- 存储 ---------- */
const KEY = "pomodoro.v1";
const DEFAULT_MODES = [
  { id: "m-default", name: "默认", focus: 25, brk: 5, color: "#ef4444", custom: false },
  { id: "m-study", name: "学习", focus: 45, brk: 10, color: "#3b82f6", custom: false },
  { id: "m-deep", name: "深度专注", focus: 50, brk: 10, color: "#8b5cf6", custom: false },
  { id: "m-light", name: "轻专注", focus: 15, brk: 5, color: "#10b981", custom: false },
];
let store = load();

// 记录唯一 id：删除/多选需要稳定标识，旧数据按 时间戳+序号 回填
const uid = () => "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
function withIds(list) {
  return (Array.isArray(list) ? list : []).map((s, i) => (s && s.id ? s : { ...s, id: `legacy-${s && s.ts}-${i}` }));
}

/* 读取本地数据。
   必须保留 updatedAt：它是跨设备同步的冲突仲裁依据（最后写入者胜）。
   早先这里漏掉了它，于是每次重新打开页面 store.updatedAt 都是 undefined，
   同步时 localTs 被当成 0，永远判定「云端更新」，
   结果本机刚完成的记录会被云端旧数据覆盖 —— 真实的数据丢失。 */
function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (raw && Array.isArray(raw.modes) && raw.modes.length) {
      return {
        modes: raw.modes,
        activeModeId: raw.activeModeId || raw.modes[0].id,
        settings: Object.assign({ theme: "light", sound: true, autoBreak: false, autoFocus: false, wake: false, dailyGoal: 8 }, raw.settings || {}),
        sessions: withIds(raw.sessions),
        interrupts: Array.isArray(raw.interrupts) ? raw.interrupts : [],
        goalDay: raw.goalDay || "",
        quests: raw.quests && raw.quests.days ? raw.quests : { days: {} },
        questXp: Number(raw.questXp) || 0,
        updatedAt: Number(raw.updatedAt) || 0,
      };
    }
  } catch (e) { /* 数据损坏则重建 */ }
  return { modes: DEFAULT_MODES.map((m) => ({ ...m })), activeModeId: "m-default",
    settings: { theme: "light", sound: true, autoBreak: false, autoFocus: false, wake: false, dailyGoal: 8 },
    sessions: [], interrupts: [], goalDay: "", quests: { days: {} }, questXp: 0, updatedAt: 0 };
}
function save() {
  try {
    if (store.sessions.length > 2000) store.sessions = store.sessions.slice(-2000);
    if (store.interrupts.length > 2000) store.interrupts = store.interrupts.slice(-2000);
    store.updatedAt = Date.now(); // 云端冲突仲裁：最后写入者胜
    localStorage.setItem(KEY, JSON.stringify(store));
    SYNC.schedulePush();
  } catch (e) { /* 忽略配额错误 */ }
}
const activeMode = () => store.modes.find((m) => m.id === store.activeModeId) || store.modes[0];

/* ---------- 计时状态 ---------- */
const T = { phase: "focus", status: "idle", remaining: 0, endAt: 0, focusMs: 0, segStart: 0 };
let timer = null;

function phaseTotal() { const m = activeMode(); return (T.phase === "focus" ? m.focus : m.brk) * 60000; }

function setPhase(phase, { run = false } = {}) {
  T.phase = phase;
  T.remaining = phaseTotal();
  T.focusMs = 0;
  T.status = "idle";
  if (run) startTimer();
  render();
}

function startTimer() {
  if (T.status === "running") return;
  T.status = "running";
  T.endAt = Date.now() + T.remaining;
  T.segStart = Date.now();
  ensureTick();
  requestWake();
  render();
}

function pauseTimer() {
  if (T.status !== "running") return;
  T.remaining = Math.max(0, T.endAt - Date.now());
  T.focusMs += Date.now() - T.segStart;
  T.status = "paused";
  releaseWake();
  render();
}

function resumeTimer() {
  if (T.status !== "paused") return;
  T.status = "running";
  T.endAt = Date.now() + T.remaining;
  T.segStart = Date.now();
  ensureTick();
  requestWake();
  render();
}

function resetTimer() {
  T.status = "idle";
  T.remaining = phaseTotal();
  T.focusMs = 0;
  releaseWake();
  render();
  toast("已重置");
}

/* 停止：仅在暂停后出现，结算本次专注 */
function stopSession() {
  if (T.status !== "paused") return;
  const focused = T.focusMs;
  T.status = "idle";
  T.remaining = phaseTotal();
  if (T.phase === "focus" && focused >= 30000) {
    store.sessions.push({ id: uid(), ts: Date.now(), m: activeMode().name, status: "stopped", sec: Math.round(focused / 1000) });
    save();
    toast(`已停止，记录 ${fmtDur(focused / 60000)} 专注 🍅`);
  } else {
    toast("已停止");
  }
  T.focusMs = 0;
  releaseWake();
  refreshAll();
}

/* 跳过：直接进入下一阶段并自动开始 */
function skipPhase() {
  const doneFocus = T.phase === "focus";
  const focused = T.focusMs + (T.status === "running" ? Date.now() - T.segStart : 0);
  if (doneFocus && focused >= 30000) {
    store.sessions.push({ id: uid(), ts: Date.now(), m: activeMode().name, status: "stopped", sec: Math.round(focused / 1000) });
    save();
  }
  const next = doneFocus ? "break" : "focus";
  setPhase(next, { run: true });
  toast(doneFocus ? "已跳过，进入休息 ☕" : "已跳过，开始专注 🍅");
}

/* 被打断：记一次中断，本阶段作废重来 */
function interruptPhase() {
  store.interrupts.push(Date.now());
  const focused = T.focusMs + (T.status === "running" ? Date.now() - T.segStart : 0);
  if (T.phase === "focus" && focused >= 30000) {
    store.sessions.push({ id: uid(), ts: Date.now(), m: activeMode().name, status: "interrupted", sec: Math.round(focused / 1000) });
  }
  save();
  T.status = "idle";
  T.remaining = phaseTotal();
  T.focusMs = 0;
  releaseWake();
  refreshAll();
  toast("已记录被打断 ⚠️");
}

/* 阶段完成 */
function completePhase() {
  const wasFocus = T.phase === "focus";
  if (wasFocus) {
    const m = activeMode();
    store.sessions.push({ id: uid(), ts: Date.now(), m: m.name, status: "completed", sec: m.focus * 60 });
    save();
    beep(true);
    checkGoal();
    setPhase("break", { run: store.settings.autoBreak });
    toast(`专注完成！休息 ${m.brk} 分钟 ☕`);
  } else {
    beep(false);
    setPhase("focus", { run: store.settings.autoFocus });
    toast(store.settings.autoFocus ? "休息结束，继续冲 💪" : "休息结束，点击开始 👟");
  }
  refreshAll();
}

function checkGoal() {
  const goal = store.settings.dailyGoal || 0;
  if (!goal) return;
  const today = countToday();
  if (today >= goal && store.goalDay !== dayKey(Date.now())) {
    store.goalDay = dayKey(Date.now());
    save();
    setTimeout(() => toast(`🎯 达成今日目标 ${goal} 个番茄！`), 800);
  }
}

/* ---------- 心跳 ---------- */
function ensureTick() { if (!timer) timer = setInterval(tick, 250); }
function tick() {
  if (T.status === "running") {
    T.remaining = T.endAt - Date.now();
    if (T.remaining <= 0) {
      T.remaining = 0;
      T.status = "idle";
      completePhase();
      return;
    }
    render();
  }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });

/* ---------- 声音 ---------- */
let ac = null;
function beep(focusDone) {
  if (!store.settings.sound) return;
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    const seq = focusDone ? [880, 1100, 1320] : [660, 520];
    seq.forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = "sine"; o.frequency.value = f;
      const t0 = ac.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      o.connect(g); g.connect(ac.destination);
      o.start(t0); o.stop(t0 + 0.2);
    });
  } catch (e) { /* 音频不可用则忽略 */ }
}

/* ---------- 屏幕常亮 ---------- */
let wakeLock = null;
async function requestWake() {
  if (!store.settings.wake || !("wakeLock" in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { /* 用户拒绝 */ }
}
function releaseWake() { if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; } }

/* ---------- 统计 ---------- */
function completedSessions() { return store.sessions.filter((s) => s.status === "completed"); }
function countToday() {
  const d0 = startOfDay(Date.now());
  return completedSessions().filter((s) => s.ts >= d0).length;
}
function countRange(from) { return completedSessions().filter((s) => s.ts >= from).length; }

function streak() {
  const days = new Set(completedSessions().map((s) => dayKey(s.ts)));
  let count = 0;
  let cur = startOfDay(Date.now());
  if (!days.has(dayKey(cur))) cur -= 86400000; // 今天还没打卡，可从昨天算起
  while (days.has(dayKey(cur))) { count++; cur -= 86400000; }
  return count;
}
function totalMinutes() { return store.sessions.reduce((a, s) => a + s.sec, 0) / 60; }

/* ---------- 等级 ---------- */
/* 等级上限集中定义：以前 99 这个数字散落在 levelOf 和等级页面两处，
   改一处漏一处就会出现「列表有 100 级、但练到 99 就卡住」的不一致。 */
const LEVEL_CAP = 100;

/* 100 级，每级一个专属名字，全部不超过 4 个字。
   命名按意象逐级递进：萌芽 → 专注修行 → 收获满园 → 攀登星空 → 神话登顶。
   前 18 个沿用原有名字，保证老用户的等级身份不变。
   名字必须两两不同：等级页面会整列展示，重名会让人以为渲染错了 */
const LEVEL_NAMES = [
  // 1-18：萌芽、收获与入门（沿用原有名字）
  "种子", "发芽", "幼苗", "青苗", "番茄苗", "结果", "满园", "番茄新手", "番茄熟手",
  "番茄达人", "专注学徒", "专注好手", "深度行者", "心流旅人", "心流大师", "效率专家", "传奇园丁", "不朽传说",
  // 19-36：专注修行，由匠人走向宗师
  "专注匠人", "心流常客", "时间猎手", "节奏掌控", "专注骑士", "心流舵手", "沉浸专家",
  "静心学徒", "静心好手", "静心匠人", "凝神行者", "聚神旅人", "入定修行", "澄心修士",
  "觉察之眼", "觉知之心", "专注宗师", "心流宗师",
  // 37-56：时间与园圃，把专注种成果园
  "时光管家", "光阴匠人", "节拍大师", "韵律行者", "番茄名家", "番茄宗师", "园圃守望",
  "果园领主", "温室匠人", "沃土耕者", "播种圣人", "花蕾守护", "绽放使者", "丰收使者",
  "硕果累累", "红果盈枝", "果园吟游", "花园隐士", "田野诗人", "沃野旅人",
  // 57-76：攀登与星空，走向更大的尺度
  "藤蔓攀者", "高塔登临", "峰顶眺望", "山巅行者", "云端漫步", "星轨观测", "星辰匠人",
  "银河摆渡", "星际旅人", "苍穹骑士", "天穹守望", "宇宙学徒", "时空旅者", "时空匠人",
  "维度行者", "光阴宗师", "时砂掌控", "沙漏守护", "刻漏大师", "永恒匠人",
  // 77-100：史诗与神话，等级阶梯的顶端
  "传说续写", "史诗吟唱", "神话编织", "传奇锻造", "无双匠人", "无极行者", "太一守望",
  "混沌初开", "秩序重建", "纪元开创", "纪元守望", "星河主宰", "时光君主", "专注王者",
  "心流帝王", "定境圣者", "悟道真人", "得道圣者", "至臻之境", "万象归一", "天地共鸣",
  "时空主宰", "永恒传说", "番茄之神",
];
function xp() { return Math.round(totalMinutes()) + completedSessions().length * 5 + (store.questXp || 0); }
function levelOf(x) {
  let lv = 1;
  while (lv < LEVEL_CAP && x >= xpNeeded(lv + 1)) lv++;
  return lv;
}
function xpNeeded(lv) { return lv <= 1 ? 0 : Math.round(60 * Math.pow(lv - 1, 1.5)); }
// 兜底只在越界时触发（上限内每级都有名字），给中性文本而不是冒充某个等级名
function levelName(lv) { return LEVEL_NAMES[lv - 1] || `Lv.${lv}`; }

/* ---------- 每日任务（等级任务） ----------
   设计要点：
   1) 任务不是「随便凑 5 条」，而是覆盖不同行为维度：番茄数 / 时长 / 打卡 / 访问 / 节奏。
   2) 每日从池中按「日期」确定性抽取，保证同一天多次打开完全一致（不能用随机数，
      否则刷新一次任务就变了，进度也会错位）。
   3) 任务进度全部从已有数据实时推导，不额外存进度，避免数据不一致。
   4) 难度按账号等级动态缩放，让高等级用户也有挑战。
*/
const QUEST_XP = { easy: 15, normal: 25, hard: 40, epic: 60 };

/* 任务数据兜底：来自云端的旧数据可能没有 quests 字段。
   这里分成「只读」与「写入」两条路径：渲染阶段绝不能产生副作用，
   否则一次纯渲染就可能把 store 改成脏数据。 */
function questDay() {
  const q = store.quests;
  if (!q || typeof q !== "object" || !q.days) return { claimed: [] };
  const d = q.days[visitKey()];
  if (!d || typeof d !== "object") return { claimed: [] };
  return { claimed: Array.isArray(d.claimed) ? d.claimed : [] };
}
function questDayMut() {
  if (!store.quests || typeof store.quests !== "object" || !store.quests.days) store.quests = { days: {} };
  const k = visitKey();
  if (!store.quests.days[k] || typeof store.quests.days[k] !== "object") store.quests.days[k] = { claimed: [] };
  const d = store.quests.days[k];
  if (!Array.isArray(d.claimed)) d.claimed = [];
  pruneDays(store.quests.days);
  return d;
}

/* dayKey 生成的月份/日期没有补零（如 "2026-9-10"），直接按字符串排序会把
   "2026-10-1" 排到 "2026-9-10" 前面，导致清理旧数据时误删最近的日子。
   这里解析回时间戳按真实日期排序。 */
function dayKeyToTs(key) {
  const p = String(key).split("-");
  if (p.length !== 3) return 0;
  const [y, m, d] = p.map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return 0;
  return new Date(y, m, d).getTime();
}
/* 只保留最近 N 天，避免无限增长 */
function pruneDays(obj, keep = 60) {
  const keys = Object.keys(obj).sort((a, b) => dayKeyToTs(a) - dayKeyToTs(b));
  while (keys.length > keep) delete obj[keys.shift()];
}

/* 访问打卡：每台设备每天首次打开页面记一次，用于「访问网页」类任务。
   刻意存在单独的 localStorage 键里，而不是 store 里：
   「今天有没有打开过这个网页」天生是每台设备各自的属性，不该参与云端同步；
   更重要的是，如果写进 store 就得调用 save()，而 save() 会刷新 updatedAt，
   导致一台数据较旧的设备刚打开页面就把「本地较新」的假象报给同步逻辑，
   反过来覆盖掉云端刚写入的新数据。 */
const VISIT_KEY = "pomodoro.visits.v1";
let firstVisitToday = false;
let visitDays = (() => {
  try {
    const o = JSON.parse(localStorage.getItem(VISIT_KEY) || "null");
    return o && typeof o === "object" ? o : {};
  } catch (e) { return {}; }
})();
function visitKey() { return dayKey(Date.now()); }
function visitsToday() { return visitDays[visitKey()] || 0; }
function markVisit() {
  firstVisitToday = visitsToday() === 0;
  const k = visitKey();
  visitDays[k] = (visitDays[k] || 0) + 1;
  pruneDays(visitDays);
  try { localStorage.setItem(VISIT_KEY, JSON.stringify(visitDays)); } catch (e) { /* 配额满则放弃 */ }
}

/* 今日已完成番茄的「模式多样性」：不同模式各完成过至少 1 个 */
function distinctModesToday() {
  const d0 = startOfDay(Date.now());
  const set = new Set();
  store.sessions.forEach((s) => {
    if (s.status === "completed" && s.ts >= d0 && s.m) set.add(s.m);
  });
  return set.size;
}

/* 今日最早的完成时间（用于「早起番茄」） */
function earliestFocusHourToday() {
  const d0 = startOfDay(Date.now());
  let best = null;
  store.sessions.forEach((s) => {
    if (s.status === "completed" && s.ts >= d0) {
      const h = new Date(s.ts).getHours();
      if (best === null || h < best) best = h;
    }
  });
  return best;
}

/* 今日所有专注的总分钟数 */
function minutesToday() {
  const d0 = startOfDay(Date.now());
  return store.sessions.filter((s) => s.ts >= d0).reduce((a, s) => a + s.sec, 0) / 60;
}

/* 今日最长的一次连续专注（分钟） */
function longestToday() {
  const d0 = startOfDay(Date.now());
  return store.sessions.filter((s) => s.ts >= d0).reduce((a, s) => Math.max(a, s.sec / 60), 0);
}

/* 今日中断次数 */
function interruptsToday() {
  const d0 = startOfDay(Date.now());
  return store.interrupts.filter((t) => t >= d0).length;
}

/* 任务池：level(lv) 用于按等级放大难度 */
const QUEST_POOL = [
  { id: "visit", icon: "🌐", diff: "easy", title: () => "打开番茄钟签到",
    hint: () => firstVisitToday ? "今天首次打开，签到成功 🌱" : `今天已打开 ${visitsToday()} 次`,
    goal: () => 1, cur: () => Math.min(1, visitsToday()), unit: "次" },
  { id: "focus-count", icon: "🍅", diff: "normal", title: (lv) => `完成 ${qFocusCount(lv)} 个番茄`,
    hint: (lv) => `今日已完成 ${countToday()} 个`,
    goal: (lv) => qFocusCount(lv), cur: () => countToday(), unit: "个" },
  { id: "focus-minutes", icon: "⏱", diff: "normal", title: (lv) => `专注满 ${qMinutes(lv)} 分钟`,
    hint: () => `今日已专注 ${Math.round(minutesToday())} 分钟`,
    goal: (lv) => qMinutes(lv), cur: () => Math.round(minutesToday()), unit: "分" },
  { id: "multi-mode", icon: "🎨", diff: "normal", title: () => "用 2 种不同模式各完成一次",
    hint: () => `今日已用到 ${distinctModesToday()} 种模式`,
    goal: () => Math.min(2, Math.max(2, store.modes.length)), cur: () => distinctModesToday(), unit: "种" },
  { id: "long-session", icon: "🧱", diff: "hard", title: (lv) => `完成一次 ≥${qLong(lv)} 分钟的深度专注`,
    hint: () => `今日最长一次 ${Math.round(longestToday())} 分钟`,
    goal: (lv) => qLong(lv), cur: () => Math.round(longestToday()), unit: "分" },
  { id: "early-bird", icon: "🌅", diff: "hard", title: () => "在 9 点前完成一个番茄",
    hint: (lv) => { const h = earliestFocusHourToday(); return h === null ? "今日还没有完成的番茄" : `今日最早 ${pad(h)}:00`; },
    goal: () => 1, cur: () => { const h = earliestFocusHourToday(); return h !== null && h < 9 ? 1 : 0; }, unit: "次" },
  { id: "no-interrupt", icon: "🛡", diff: "hard", title: (lv) => `完成 ${qFocusCount(lv)} 个番茄且不被打断`,
    hint: () => interruptsToday() ? `今日已被打断 ${interruptsToday()} 次` : "今日还没有被打断，保持住",
    goal: (lv) => qFocusCount(lv), cur: () => (interruptsToday() ? 0 : countToday()), unit: "个" },
  { id: "streak-keep", icon: "🔥", diff: "easy", title: () => "保持连续打卡",
    hint: () => `当前连续 ${streak()} 天`,
    goal: () => 1, cur: () => (streak() >= 1 ? 1 : 0), unit: "天" },
  { id: "goal-hit", icon: "🎯", diff: "epic", title: (lv) => `达成本日目标 ${store.settings.dailyGoal || 8} 个番茄`,
    hint: (lv) => `目标 ${store.settings.dailyGoal || 8} 个，已完成 ${countToday()} 个`,
    goal: () => (store.settings.dailyGoal || 8), cur: () => countToday(), unit: "个" },
  { id: "marathon", icon: "🏔", diff: "epic", title: (lv) => `累计专注满 ${qMarathon(lv)} 分钟`,
    hint: () => `今日已专注 ${Math.round(minutesToday())} 分钟`,
    goal: (lv) => qMarathon(lv), cur: () => Math.round(minutesToday()), unit: "分" },
];

function qFocusCount(lv) { return Math.min(14, 2 + Math.floor(lv / 2)); }
function qMinutes(lv) { return Math.min(240, 25 + lv * 10); }
function qLong(lv) { return Math.min(90, 25 + lv * 5); }
function qMarathon(lv) { return Math.min(360, 60 + lv * 20); }

/* 每日任务：按日期做确定性抽取，保证一天之内稳定不变 */
const DAILY_QUEST_COUNT = 5;
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/* 以日期为种子做确定性洗牌（mulberry32） */
function seededPick(seedStr, n) {
  let a = hashStr(seedStr);
  const rnd = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pool = QUEST_POOL.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = pool.slice(0, n);
  // 「访问网页」是每日固定项（用户明确要求），始终保留
  const visit = QUEST_POOL.find((q) => q.id === "visit");
  if (visit && !picked.includes(visit)) picked[picked.length - 1] = visit;
  return picked;
}

function todayQuests() {
  const lv = levelOf(xp());
  const day = questDay();
  return seededPick(dayKey(Date.now()), DAILY_QUEST_COUNT).map((q) => {
    const goal = q.goal(lv);
    const cur = Math.min(goal, q.cur(lv));
    const done = cur >= goal;
    return {
      id: q.id, icon: q.icon, diff: q.diff, done,
      claimed: day.claimed.includes(q.id),
      goal, cur, unit: q.unit,
      pct: goal > 0 ? Math.min(100, (cur / goal) * 100) : 100,
      xp: QUEST_XP[q.diff] || 20,
      title: q.title(lv), hint: q.hint(lv),
    };
  });
}

/* 领取单个任务奖励；返回获得的 XP */
function claimQuest(id) {
  const q = todayQuests().find((x) => x.id === id);
  if (!q || !q.done || q.claimed) return 0;
  questDayMut().claimed.push(id);
  store.questXp = (store.questXp || 0) + q.xp;
  save();
  return q.xp;
}

/* ---------- 渲染 ---------- */
const RING_C = 2 * Math.PI * 146;
let tvOpen = false;

function render() {
  const m = activeMode();
  const total = phaseTotal();
  const elapsed = Math.min(total, total - T.remaining);
  const ratio = total ? elapsed / total : 0;

  // 圆环
  $("ringProgress").style.strokeDasharray = RING_C;
  $("ringProgress").style.strokeDashoffset = RING_C * (1 - ratio);

  // 文本
  const clock = fmtClock(T.status === "idle" && T.focusMs === 0 && T.remaining === total ? total : T.remaining);
  $("timeText").textContent = clock;
  $("phaseTag").textContent = T.phase === "focus" ? "专注" : "休息";
  $("modeSub").textContent = `${m.name} · ${m.focus}/${m.brk} 分钟`;
  const statusMap = {
    running: T.phase === "focus" ? "保持节奏，你做得很好" : "放松一下，喝口水",
    paused: "已暂停 · 点击继续或停止",
    idle: T.phase === "focus" ? "点击开始，进入专注" : "准备好后开始休息",
  };
  $("statusLine").textContent = statusMap[T.status];

  // 主按钮：运行→暂停；暂停→被「停止」替换；空闲→开始
  const mainBtn = $("mainBtn"), resumeBtn = $("resumeBtn");
  if (T.status === "running") {
    mainBtn.textContent = "⏸ 暂停"; mainBtn.classList.remove("btn-danger", "hidden");
    resumeBtn.classList.add("hidden");
  } else if (T.status === "paused") {
    mainBtn.textContent = "⏹ 停止"; mainBtn.classList.add("btn-danger");
    mainBtn.classList.remove("hidden");
    resumeBtn.textContent = "▶ 继续"; resumeBtn.classList.remove("hidden");
  } else {
    mainBtn.textContent = T.phase === "focus" ? "▶ 开始" : "▶ 开始休息";
    mainBtn.classList.remove("btn-danger", "hidden");
    resumeBtn.classList.add("hidden");
  }

  // 阶段配色：专注用模式色，休息用绿色
  const accent = T.phase === "focus" ? m.color : "#10b981";
  document.documentElement.style.setProperty("--accent", accent);
  document.documentElement.style.setProperty("--accent-soft", hexA(accent, 0.14));

  // 番茄视图
  if (tvOpen) {
    $("tvTime").textContent = clock;
    $("tvPhase").textContent = `${T.phase === "focus" ? "专注" : "休息"} · ${m.name}`;
    $("tvPause").textContent = T.status === "running" ? "⏸ 暂停" : T.status === "paused" ? "▶ 继续" : "▶ 开始";
    $("tvTomato").classList.toggle("blink", T.status === "running");
  }

  // 标题
  document.title = (T.status !== "idle" ? `${clock} · ` : "") + (T.phase === "focus" ? "🍅 " : "☕ ") + "番茄钟";
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ---------- Jelly Radio 模式按钮（motion 弹簧动画） ---------- */
const JR_CFG = { swell: 0.2, barge: 6, shrink: 0.05, jelly: 1, bounce: 0.25, stagger: 22, stiffness: 580 };
const JR_MOTION = typeof window.Motion !== "undefined" && typeof window.Motion.animate === "function" ? window.Motion : null;
const JR_REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
let jrChips = [];   // { el, x, sx, sy, animUntil }
let jrWidths = [];
let jrSig = "";
let jrLastSel = -1;

function jrSpring(k, m, bounce) {
  return { type: "spring", stiffness: k, damping: 2 * Math.sqrt(k * m) * (1 - bounce), mass: m };
}
function jrPaint(chip) {
  chip.el.style.transform = `translateX(${chip.x.get()}px) scale(${chip.sx.get()}, ${chip.sy.get()})`;
}
function jrJump(mv, v) {
  if (typeof mv.jump === "function") mv.jump(v);
  else mv.set(v);
}
function jrCreateChip(mode) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "jelly-radio__chip";
  el.setAttribute("role", "radio");
  el.title = mode.custom ? `${mode.name} · 点击切换，点击 ✎ 编辑` : `${mode.name} · ${mode.focus}/${mode.brk} 分钟`;
  el.style.setProperty("--jr-active", mode.color);
  el.innerHTML =
    `<span class="jelly-radio__skin"><span class="jelly-radio__label">${esc(mode.name)}</span>` +
    (mode.custom ? ' <span class="chip-del" title="编辑模式">✎</span>' : "") +
    `</span>`;
  el.onclick = (e) => {
    if (e.target.closest && e.target.closest(".chip-del")) { openModeModal(mode); return; }
    switchMode(mode.id);
  };
  // 方向键在模式间移动（Jelly Radio 无障碍支持）
  el.onkeydown = (e) => {
    const idx = store.modes.findIndex((m) => m.id === mode.id);
    let next = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % store.modes.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (idx - 1 + store.modes.length) % store.modes.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = store.modes.length - 1;
    if (next === null) return;
    e.preventDefault();
    switchMode(store.modes[next].id);
    const c = jrChips[next];
    if (c) c.el.focus();
  };
  const chip = { el, animUntil: 0 };
  if (JR_MOTION) {
    chip.x = new JR_MOTION.MotionValue(0);
    chip.sx = new JR_MOTION.MotionValue(1);
    chip.sy = new JR_MOTION.MotionValue(1);
    [chip.x, chip.sx, chip.sy].forEach((mv) => mv.on("change", () => jrPaint(chip)));
  } else {
    const mk = (v) => ({ get: () => v, jump: (n) => (v = n), set: (n) => (v = n), on: () => {} });
    chip.x = mk(0); chip.sx = mk(1); chip.sy = mk(1);
  }
  jrPaint(chip);
  return chip;
}
function jrMeasure() {
  if (!jrChips.length) return;
  const group = $("modeChips");
  const bar = group.parentElement || group;
  jrWidths = jrChips.map((c) => c.el.offsetWidth);
  const chipH = jrChips[0].el.offsetHeight || 36;
  const maxW = Math.max(0, ...jrWidths);
  const C = JR_CFG;
  // 最坏情况下选中项把紧邻的模式向外挤开的距离（与 jrApply 的 push 公式一致）。
  // 「＋ 模式」按钮不会跟着位移，所以左侧预留一份挤开量，避免最后一个模式被挤过来
  // 时压到按钮上（实测不预留会重叠约 1px）。
  const shift = (maxW * C.swell) / 2 + C.barge;
  group.style.setProperty("--jr-pad-x", `${Math.ceil((maxW * C.swell * 1.3) / 2 + C.barge) + 2}px`);
  group.style.setProperty("--jr-pad-y", `${Math.ceil((chipH * C.swell) / 2) + 2}px`);
  // 设在父级（.mode-bar）上，「＋ 模式」作为兄弟节点也能继承到
  bar.style.setProperty("--jr-shift-room", `${Math.ceil(shift)}px`);
  // 把放大倍数交给 CSS：换行时纵向间距要按它补偿，避免两行贴得和行内空格一样近
  group.style.setProperty("--jr-swell", `${C.swell}`);
  jrAlignAdd();
}
/* 「＋ 模式」只留了左侧 margin（用于避开被挤过来的模式），因此它**独占一行**时
   会相对居中右偏 marginLeft/2。居中在两种情形下对 margin 的要求互相矛盾
   （同行要求右侧 margin 为 0，独占要求左右相等），无法同时满足，故这里对
   「独占一行」的情形做纯视觉补偿（translate，不参与布局，不会引起重排抖动）。 */
function jrAlignAdd() {
  const add = $("addModeBtn");
  if (!add) return;
  const group = $("modeChips");
  if (!jrChips.length || !group.contains(add)) {
    add.style.setProperty("--jr-alone-shift", "0px");
    return;
  }
  // offsetTop 是布局值（不含 transform），与最后一个模式同一行则说明并未独占一行
  const sameRow = Math.abs(add.offsetTop - jrChips[jrChips.length - 1].el.offsetTop) < 2;
  const room = parseFloat(getComputedStyle(add).marginLeft) || 0;
  // margin-left: M 时，flex 居中的是「margin 盒」，因此按钮实际中心落在容器中心
  // 右侧 M/2 处，需向左移回 M/2。
  add.style.setProperty("--jr-alone-shift", sameRow ? "0px" : `${(-room / 2).toFixed(1)}px`);
}
function jrApply(sel, instant) {
  if (!jrChips.length) return;
  const C = JR_CFG;
  const push = ((jrWidths[sel] || 0) * C.swell) / 2 + C.barge;
  const now = performance.now();
  jrChips.forEach((chip, i) => {
    const on = i === sel;
    const far = Math.abs(i - sel);
    const dir = Math.sign(i - sel);
    const x = dir * push;
    const s = on ? 1 + C.swell : 1 - C.shrink;
    if (instant || JR_REDUCED || !JR_MOTION) {
      jrJump(chip.x, x); jrJump(chip.sx, s); jrJump(chip.sy, s);
      return;
    }
    const k = C.stiffness * (1 - 0.12 * Math.min(far, 3));
    const delay = now < chip.animUntil ? 0 : (far * C.stagger) / 1000;
    const j = C.jelly;
    JR_MOTION.animate(chip.x, x, { ...jrSpring(k, 0.9, C.bounce), delay });
    JR_MOTION.animate(chip.sx, s, { ...jrSpring(k * (1 + 0.24 * j), 0.9 - 0.1 * j, Math.min(0.85, C.bounce + 0.3 * j)), delay });
    JR_MOTION.animate(chip.sy, s, { ...jrSpring(k * (1 - 0.14 * j), 0.9 + 0.05 * j, C.bounce), delay: delay + 0.05 * j });
    chip.animUntil = now + 700 + delay * 1000;
  });
}

function renderChips() {
  const wrap = $("modeChips");
  const addBtn = $("addModeBtn");
  const sig = store.modes.map((m) => `${m.id}:${m.name}:${m.focus}:${m.brk}:${m.color}:${m.custom}`).join("|");
  const selIdx = Math.max(0, store.modes.findIndex((m) => m.id === store.activeModeId));
  let rebuilt = false;
  if (sig !== jrSig) {
    jrSig = sig;
    // 重建前先移出「＋ 模式」，避免被 innerHTML 清掉（保留其事件绑定）
    if (addBtn && addBtn.parentElement === wrap) wrap.removeChild(addBtn);
    wrap.innerHTML = "";
    jrChips = store.modes.map((m) => { const c = jrCreateChip(m); wrap.appendChild(c.el); return c; });
    // 追加到所有模式按钮之后，跟随模式按钮一起换行
    if (addBtn) wrap.appendChild(addBtn);
    jrLastSel = -1;
    rebuilt = true;
  }
  jrChips.forEach((c, i) => {
    const on = i === selIdx;
    c.el.dataset.on = on ? "true" : "false";
    c.el.setAttribute("aria-checked", on ? "true" : "false");
    c.el.tabIndex = on ? 0 : -1;
  });
  if (rebuilt || selIdx !== jrLastSel) {
    const instant = rebuilt || jrLastSel === -1;
    jrLastSel = selIdx;
    jrMeasure();
    jrApply(selIdx, instant);
  }
}
function switchMode(id) {
  if (id === store.activeModeId) return;
  store.activeModeId = id;
  save();
  const wasFocus = T.phase === "focus";
  T.status = "idle";
  T.remaining = (wasFocus ? activeMode().focus : activeMode().brk) * 60000;
  T.focusMs = 0;
  releaseWake();
  refreshAll();
  toast(`已切换到「${activeMode().name}」模式`);
}

function renderLevel() {
  const x = xp(), lv = levelOf(x);
  const maxed = lv >= LEVEL_CAP;
  const cur = xpNeeded(lv);
  // 满级时不存在下一级：不能拿 xpNeeded(101) 当目标，否则会显示一个永远到不了的进度
  const next = maxed ? cur : xpNeeded(lv + 1);
  const pct = maxed ? 100 : next > cur ? Math.min(100, ((x - cur) / (next - cur)) * 100) : 100;
  $("levelBadge").textContent = lv;
  $("levelName").textContent = `Lv.${lv} ${levelName(lv)}`;
  $("levelXp").textContent = maxed ? `${x} XP · 已满级` : `${x} / ${next} XP`;
  $("levelNext").textContent = maxed ? "已达最高等级 🎉" : `下一级：${levelName(lv + 1)}`;
  $("levelFill").style.width = pct + "%";
  $("brandLevelFull").textContent = `Lv.${lv} ${levelName(lv)}`;
  $("brandLevelShort").textContent = `Lv.${lv}`;
  $("brandLevel").title = `Lv.${lv} ${levelName(lv)} · 点击查看全部等级`;
  // 等级页面打开时同步刷新，避免领取任务后看到过期数据
  if (lvOpen) renderLevelPage();
}

/* 每日任务面板（默认折叠，只渲染数据，展开状态由用户控制）
   每天 5 个任务，完成后点「领取」把 XP 计入等级。 */
const DIFF_LABEL = { easy: "简单", normal: "普通", hard: "困难", epic: "史诗" };
function renderTasks() {
  const panel = $("taskPanelInner");
  const list = todayQuests();
  const doneN = list.filter((q) => q.done).length;
  const claimable = list.filter((q) => q.done && !q.claimed).length;

  // 折叠状态下也要更新徽标
  const badge = $("taskBadge");
  if (badge) {
    badge.textContent = claimable ? `${claimable} 可领取` : `${doneN}/${list.length}`;
    badge.classList.toggle("ready", claimable > 0);
    badge.classList.toggle("hidden", false);
  }
  if (!$("taskPanel").classList.contains("open")) return; // 折叠时不刷新 DOM

  const resetHint = `每日 0 点刷新 · 今日已完成 ${doneN}/${list.length}`;
  panel.innerHTML =
    `<div class="task-note">${esc(resetHint)}</div>` +
    list.map((t, i) => {
      const state = t.claimed ? "已领取" : t.done ? "领取" : `${t.cur}/${t.goal} ${t.unit}`;
      const cls = `task-row${t.done ? " done" : ""}${t.claimed ? " claimed" : ""}`;
      return `
      <div class="${cls}" data-quest="${t.id}" style="animation-delay:${(i * 0.05).toFixed(2)}s">
        <span class="task-icon">${t.claimed ? "🎁" : t.done ? "✅" : t.icon}</span>
        <div class="task-body">
          <div class="task-title">${esc(t.title)} <span class="task-diff diff-${t.diff}">${DIFF_LABEL[t.diff]}</span></div>
          <div class="task-hint">${esc(t.hint)} · +${t.xp} XP</div>
          <div class="task-bar"><div class="task-bar-fill" style="width:${t.pct}%"></div></div>
        </div>
        ${t.done && !t.claimed
          ? `<button type="button" class="task-claim" data-claim="${t.id}">${state}</button>`
          : `<span class="task-pct">${t.claimed ? "已领" : Math.floor(t.pct) + "%"}</span>`}
      </div>`;
    }).join("");

  panel.querySelectorAll("[data-claim]").forEach((btn) => {
    btn.onclick = () => {
      const got = claimQuest(btn.dataset.claim);
      if (!got) return;
      toast(`任务完成！+${got} XP 🎉`);
      refreshAll();
    };
  });
}

function renderOverview() {
  const d0 = startOfDay(Date.now());
  $("ovTotal").textContent = completedSessions().length;
  $("ovToday").textContent = countToday();
  $("ovWeek").textContent = countRange(d0 - 6 * 86400000);
  $("ovStreak").textContent = streak();
  $("ovTime").textContent = fmtDur(totalMinutes());
  $("ovInterrupt").textContent = store.interrupts.length;

  $("miniToday").textContent = `${countToday()}/${store.settings.dailyGoal || 8}`;
  $("miniStreak").textContent = streak();
  $("miniTodayTime").textContent = fmtDur(store.sessions.filter((s) => s.ts >= d0).reduce((a, s) => a + s.sec, 0) / 60);
}

/* ---------- 范围统计 ---------- */
const RANGE_DEFS = {
  today: { days: 1, label: "今天" },
  "7d": { days: 7, label: "近7天" },
  "1m": { days: 30, label: "近1个月" },
  "6m": { days: 182, label: "近半年" },
  "1y": { days: 365, label: "近1年" },
};
let curRange = "today";

function renderRange() {
  const def = RANGE_DEFS[curRange];
  const d0 = startOfDay(Date.now());
  const from = def.days === 1 ? d0 : d0 - (def.days - 1) * 86400000;

  const sess = store.sessions.filter((s) => s.ts >= from);
  const done = sess.filter((s) => s.status === "completed");
  const interrupts = store.interrupts.filter((t) => t >= from).length;

  $("rsCount").textContent = done.length;
  $("rsTime").textContent = fmtDur(sess.reduce((a, s) => a + s.sec, 0) / 60);
  $("rsInterrupt").textContent = interrupts;
  $("rsAvg").textContent = (done.length / def.days).toFixed(1);

  drawChart(from, def);
}

function drawChart(from, def) {
  const chart = $("chart");
  chart.innerHTML = "";
  const now = Date.now();
  let buckets = []; // {label, from, to}

  if (def.days === 1) {                       // 今天：24 小时
    for (let h = 0; h < 24; h++) buckets.push({ label: `${pad(h)}时`, from: from + h * 3600000, to: from + (h + 1) * 3600000 });
    $("chartCaption").textContent = "今天每小时专注分钟数";
  } else if (def.days <= 30) {                // 日粒度
    for (let i = 0; i < def.days; i++) { const b = from + i * 86400000; buckets.push({ label: new Date(b).getDate() + "日", from: b, to: b + 86400000 }); }
    $("chartCaption").textContent = `每日专注分钟数（${def.label}）`;
  } else if (def.days <= 182) {               // 周粒度
    for (let b = from; b < now; b += 7 * 86400000) buckets.push({ label: new Date(b).getMonth() + 1 + "/" + new Date(b).getDate(), from: b, to: Math.min(b + 7 * 86400000, now) });
    $("chartCaption").textContent = `每周专注分钟数（${def.label}）`;
  } else {                                    // 月粒度
    const d = new Date(from); d.setDate(1);
    while (d.getTime() < now) {
      const s = d.getTime();
      d.setMonth(d.getMonth() + 1);
      buckets.push({ label: (new Date(s).getMonth() + 1) + "月", from: Math.max(s, from), to: d.getTime() });
    }
    $("chartCaption").textContent = `每月专注分钟数（${def.label}）`;
  }

  const vals = buckets.map((b) => store.sessions.filter((s) => s.ts >= b.from && s.ts < b.to).reduce((a, s) => a + s.sec, 0) / 60);
  const max = Math.max(1, ...vals);

  buckets.forEach((b, i) => {
    const v = Math.round(vals[i]);
    const bar = document.createElement("div");
    bar.className = "bar" + (v <= 0 ? " zero" : "");
    bar.style.height = v > 0 ? Math.max(6, (v / max) * 100) + "%" : "";
    bar.title = `${b.label}：${v} 分钟`;
    chart.appendChild(bar);
  });
}

/* ---------- 最近记录：可点击看详情 + 多选删除 ---------- */
const HIST = { manage: false, expanded: false, sel: new Set(), openId: null };
const HIST_PREVIEW = 14; // 折叠时最多显示条数

/* 按时间倒序（新的在前）。
   不依赖数组顺序：云端同步合并后的数据顺序未必是写入顺序，
   按 ts 排序才能保证「最近记录」真的按时间排列。 */
function historySorted() {
  return store.sessions.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

function fmtAbs(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function dayLabel(ts) {
  const now = Date.now();
  if (ts >= startOfDay(now)) return "今天";
  if (ts >= startOfDay(now) - 86400000) return "昨天";
  const d = new Date(ts);
  return `${d.getMonth() + 1}-${pad(d.getDate())}`;
}
const STATUS_META = {
  completed: { text: "完成", cls: "ok", ico: "🍅" },
  interrupted: { text: "打断", cls: "bad", ico: "⚠️" },
  stopped: { text: "停止", cls: "bad", ico: "⏹" },
};
const statusMeta = (s) => STATUS_META[s] || STATUS_META.stopped;

function renderHistory() {
  const box = $("history");
  const all = historySorted(); // 新的在前
  const list = HIST.expanded ? all : all.slice(0, HIST_PREVIEW);

  // 清理已不存在的选中项（例如被删除后又刷新）
  const alive = new Set(all.map((s) => s.id));
  HIST.sel.forEach((id) => { if (!alive.has(id)) HIST.sel.delete(id); });

  $("historyCount").textContent = all.length ? `共 ${all.length} 条` : "";
  const expandBtn = $("historyExpandBtn");
  expandBtn.classList.toggle("hidden", all.length <= HIST_PREVIEW);
  expandBtn.textContent = HIST.expanded ? "收起" : `展开全部 (${all.length})`;
  $("historyManageBtn").classList.toggle("on", HIST.manage);
  $("historyManageBtn").textContent = HIST.manage ? "完成" : "管理";
  $("historyBar").classList.toggle("hidden", !HIST.manage);
  $("history").classList.toggle("expanded", HIST.expanded);

  if (!all.length) {
    box.innerHTML = '<div class="history-empty">还没有记录，完成一次专注后这里会出现历史 🍅</div>';
    syncHistoryBar();
    return;
  }

  box.innerHTML = list.map((s) => {
    const d = new Date(s.ts);
    const meta = statusMeta(s.status);
    const checked = HIST.sel.has(s.id) ? " checked" : "";
    const selCls = HIST.sel.has(s.id) ? " selected" : "";
    const openCls = HIST.openId === s.id ? " active" : "";
    // 编辑模式：整行点击切换选中；普通模式：整行点击打开详情
    return `<div class="h-row${selCls}${openCls}" data-id="${esc(s.id)}" tabindex="0" role="button"
      aria-label="${esc(s.m + " " + fmtDur(s.sec / 60) + " " + meta.text)}">
      ${HIST.manage ? `<input type="checkbox" class="h-check"${checked} aria-label="选择这条记录">` : '<span class="h-dot"></span>'}
      <span class="h-main">${esc(s.m)} · ${fmtDur(s.sec / 60)}</span>
      <span class="h-tag ${meta.cls}">${meta.text}</span>
      <span class="h-time">${dayLabel(s.ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}</span>
    </div>`;
  }).join("") + (!HIST.expanded && all.length > HIST_PREVIEW
    ? `<button type="button" class="mini-btn history-more" id="historyMoreBtn">还有 ${all.length - HIST_PREVIEW} 条，展开查看</button>`
    : "");

  syncHistoryBar();
  bindHistoryRows();
}

function syncHistoryBar() {
  const n = HIST.sel.size;
  $("historySelCount").textContent = `已选 ${n} 条`;
  $("historyDeleteBtn").disabled = n === 0;
  // 与渲染用的集合保持一致，否则「全选」状态会与实际勾选不符
  const sorted = historySorted();
  const list = HIST.expanded ? sorted : sorted.slice(0, HIST_PREVIEW);
  const ids = list.map((s) => s.id);  const allSel = ids.length > 0 && ids.every((id) => HIST.sel.has(id));
  const allBox = $("historyAll");
  allBox.checked = allSel;
  allBox.indeterminate = !allSel && ids.some((id) => HIST.sel.has(id));
}

function bindHistoryRows() {
  const box = $("history");
  box.querySelectorAll(".h-row").forEach((row) => {
    const id = row.dataset.id;
    row.onclick = (e) => {
      if (HIST.manage) {
        // 编辑模式：点复选框本身按浏览器默认行为走，其余位置切换选中
        if (e.target.classList.contains("h-check")) return;
        toggleHistSel(id);
      } else {
        openRecord(id);
      }
    };
    row.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      if (HIST.manage) toggleHistSel(id); else openRecord(id);
    };
  });
  box.querySelectorAll(".h-check").forEach((cb) => {
    cb.onclick = (e) => { e.stopPropagation(); toggleHistSel(cb.closest(".h-row").dataset.id); };
  });
  const more = $("historyMoreBtn");
  if (more) more.onclick = () => { HIST.expanded = true; renderHistory(); };
}

function toggleHistSel(id) {
  if (HIST.sel.has(id)) HIST.sel.delete(id); else HIST.sel.add(id);
  const row = document.querySelector(`.h-row[data-id="${CSS.escape(id)}"]`);
  if (row) {
    row.classList.toggle("selected", HIST.sel.has(id));
    const cb = row.querySelector(".h-check");
    if (cb) cb.checked = HIST.sel.has(id);
  }
  syncHistoryBar();
}

function setHistManage(on) {
  HIST.manage = on;
  if (!on) HIST.sel.clear();
  renderHistory();
}

function deleteHistoryIds(ids) {
  if (!ids.length) return 0;
  const set = new Set(ids);
  const before = store.sessions.length;
  store.sessions = store.sessions.filter((s) => !set.has(s.id));
  HIST.sel.clear();
  save();
  return before - store.sessions.length;
}

/* 记录详情 */
function openRecord(id) {
  const s = store.sessions.find((x) => x.id === id);
  if (!s) return;
  HIST.openId = id;
  const meta = statusMeta(s.status);
  const d = new Date(s.ts);
  $("recIco").textContent = meta.ico;
  $("recMain").textContent = `${s.m} · ${fmtDur(s.sec / 60)}`;
  $("recSub").textContent = `${meta.text} · ${dayLabel(s.ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $("recGrid").innerHTML = [
    ["模式", esc(s.m)],
    ["状态", meta.text],
    ["专注时长", fmtDur(s.sec / 60)],
    ["折算分钟", Math.round(s.sec / 60) + " 分钟"],
    ["日期", `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`],
    ["时间", `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`],
    ["星期", "星期" + "日一二三四五六"[d.getDay()]],
    ["完整时间", fmtAbs(s.ts)],
  ].map(([k, v]) => `<div class="rec-cell"><div class="rec-k">${k}</div><div class="rec-v">${v}</div></div>`).join("");
  $("recordModal").classList.remove("hidden");
}

function closeRecord() {
  HIST.openId = null;
  const m = $("recordModal");
  document.querySelectorAll(".h-row.active").forEach((r) => r.classList.remove("active"));
  if (m.classList.contains("hidden")) return;
  if (JR_REDUCED) { m.classList.add("hidden"); return; }
  m.classList.add("closing");
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    m.removeEventListener("animationend", onEnd);
    m.classList.add("hidden");
    m.classList.remove("closing");
  };
  const onEnd = (e) => { if (e.target === m) finish(); };
  m.addEventListener("animationend", onEnd);
  setTimeout(finish, 400);
}

function refreshAll() {
  renderChips();
  renderOverview();
  renderRange();
  renderLevel();
  renderTasks();
  renderHistory();
  render();
}

/* ---------- 番茄视图 ---------- */
let tvClosing = false;

/* 戳一戳番茄：果冻挤压 + 粒子飞溅 + 语气泡 */
const TV_PHRASES = [
  // 日常吐槽
  "别戳我啦！专心～ 🍅", "再戳就熟了！", "嘿！好痒 😆", "番茄也要休息呀",
  "专注的人最帅了 ✨", "被你戳晕了…", "呜呜 🥺", "去学习！别玩我！",
  "戳我也没用，快计时 ⏰", "今天的番茄格外甜 🍅", "再戳给你变大！", "抗议！严重抗议！",
  // 撒娇/情绪
  "再戳我就哭给你看 😭", "哼！生气了！", "你是不是暗恋我呀～ 💕", "轻点啦，人家怕痒",
  "我是番茄，不是沙包！", "戳上瘾了是吧？", "好啦好啦，我投降 🏳️", "你手不酸吗？",
  "再戳就要收费了 💰", "本番茄要告你骚扰！", "别闹～人家在冥想 🧘",
  // 鼓励/催学
  "放下番茄，拿起书本！📚", "时间在流逝哦 ⏳", "专注 25 分钟试试？",
  "你已经很棒了，继续保持 💪", "摸鱼被我抓到了吧？", "距离学霸只差一个番茄",
  "今日份的番茄完成了吗？", "别玩了，目标还没达成 🎯", "番茄与你同在 🍅✨",
  // 里程碑特殊（按次数触发）
  "已戳 10 次！手速惊人 🏎️", "25 次！这耐心可以用来学习了 📖", "50 次！番茄都被你戳出感情了 💗",
  "100 次！！你是戳番茄宗师 👑",
];
const TV_MILESTONES = { 10: 0, 25: 1, 50: 2, 100: 3 }; // 索引指向里程碑语
let tvPokeCount = 0;
let tvBubbleTimer = 0;
let tvLastPhraseIdx = -1;

function pokeTomato(e) {
  if (JR_REDUCED) return; // 减少动效偏好下不互动
  const el = $("tvTomato");
  // 依据点击方向给番茄一个反向倾斜，戳哪边歪哪边
  if (e) {
    const r = el.getBoundingClientRect();
    const rel = (e.clientX - (r.left + r.width / 2)) / (r.width / 2); // -1~1
    el.style.setProperty("--poke-tilt", `${(-rel * 10).toFixed(1)}deg`);
  }
  // 果冻挤压：重启动画
  el.classList.remove("poke");
  void el.offsetWidth;
  el.classList.add("poke");

  tvPokeCount++;
  const rect = el.getBoundingClientRect();
  const layer = $("tvParticles");
  const layerRect = layer.getBoundingClientRect();
  const cx = (e ? e.clientX : rect.left + rect.width / 2) - layerRect.left;
  const cy = (e ? e.clientY : rect.top + rect.height / 2) - layerRect.top;

  /* 亮光跟随点击处
     根因：光晕原本是固定的 <ellipse cx=100 cy=118>，径向渐变也用百分比（相对包围盒），
     所以无论点哪里，亮光都长在番茄正中间。
     修复：把点击的屏幕坐标换算成 SVG 用户坐标，同时移动光斑椭圆与渐变中心，
     让亮光真的从手指按下的地方亮起来。 */
  if (e) {
    const svg = el.querySelector("svg");
    if (svg && svg.getScreenCTM) {
      try {
        const pt = svg.createSVGPoint();
        pt.x = e.clientX; pt.y = e.clientY;
        const u = pt.matrixTransform(svg.getScreenCTM().inverse());
        // 限制在番茄身体范围内，避免光斑跑到叶子上
        const gx = Math.max(30, Math.min(170, u.x));
        const gy = Math.max(54, Math.min(184, u.y));
        const glow = svg.querySelector(".tv-glow");
        if (glow) {
          glow.setAttribute("cx", gx.toFixed(1));
          glow.setAttribute("cy", gy.toFixed(1));
          // 动画以 transform-origin 为缩放中心，必须一起挪，否则光斑仍从中心扩散
          glow.style.transformOrigin = `${gx.toFixed(1)}px ${gy.toFixed(1)}px`;
        }
        const grad = svg.querySelector("#tvGlowGrad");
        if (grad) { grad.setAttribute("cx", gx.toFixed(1)); grad.setAttribute("cy", gy.toFixed(1)); }
      } catch (_) { /* 取不到矩阵时保持默认位置 */ }
    }
  }

  // 冲击波：一圈柔和光涟漪从点击点扩散消失（先清旧的，防连点残留）
  layer.querySelectorAll(".tv-shock").forEach((s) => s.remove());
  const shock = document.createElement("span");
  shock.className = "tv-shock";
  shock.style.left = `${cx}px`;
  shock.style.top = `${cy}px`;
  layer.appendChild(shock);
  if (typeof shock.animate === "function") {
    const a = shock.animate(
      [
        { transform: "translate(-50%, -50%) scale(.3)", opacity: .85 },
        { transform: "translate(-50%, -50%) scale(3.6)", opacity: 0 },
      ],
      { duration: 420, easing: "cubic-bezier(.16,.84,.44,1)", fill: "forwards" }
    );
    // 动画一结束立刻移除，杜绝残影
    if (a.finished && typeof a.finished.then === "function") {
      a.finished.then(() => shock.remove()).catch(() => shock.remove());
    } else {
      a.onfinish = () => shock.remove();
    }
  } else {
    shock.remove();
  }
  setTimeout(() => shock.remove(), 600); // 兜底

  // 粒子飞溅：两波错帧（近处大粒子先出，远处小粒子后出），运动更连贯
  const emojis = ["✨", "💥", "⭐", "🌟", "💫", "❤️", "💦", "🍃", "🔴", "😊"];
  const n = 7 + Math.floor(Math.random() * 4); // 7~10 个
  for (let i = 0; i < n; i++) {
    const p = document.createElement("span");
    p.className = "tv-particle";
    p.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    // 均匀放射 + 随机扰动
    const angle = (Math.PI * 2 * i) / n + (Math.random() - 0.5) * 0.6;
    const dist = 70 + Math.random() * 110;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist - 26;
    const rot = (Math.random() - 0.5) * 480;
    const scale0 = 0.75 + Math.random() * 0.65;
    layer.appendChild(p);
    p.style.left = `${cx}px`;
    p.style.top = `${cy}px`;
    p.style.fontSize = `${16 + Math.random() * 14}px`;
    if (!JR_REDUCED && typeof p.animate === "function") {
      // 单段 ease-out 抛物：起步快、末段慢落，无关键帧折线感
      p.animate(
        [
          { transform: "translate(-50%, -50%) scale(.3) rotate(0deg)", opacity: 0 },
          { transform: `translate(calc(-50% + ${dx * .5}px), calc(-50% + ${dy * .5 - 14}px)) scale(${scale0}) rotate(${rot * .45}deg)`, opacity: 1, offset: .28 },
          { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 26}px)) scale(${scale0 * .88}) rotate(${rot * .8}deg)`, opacity: .95, offset: .62 },
          { transform: `translate(calc(-50% + ${dx * 1.04}px), calc(-50% + ${dy + 96}px)) scale(${scale0 * .55}) rotate(${rot}deg)`, opacity: 0 },
        ],
        {
          duration: 950 + Math.random() * 450,
          delay: (i % 2) * 40,           // 双波错帧，观感更绵密
          easing: "cubic-bezier(.12,.72,.28,1)",
          fill: "forwards",
        }
      );
    } else {
      p.style.transform = `translate(-50%, -50%) translate(${dx}px, ${dy}px)`;
      p.style.opacity = "0";
    }
    setTimeout(() => p.remove(), 1700);
  }
  // 语气泡：里程碑优先，普通吐槽防连续重复
  const bubble = $("tvBubble");
  let phrase;
  const mi = TV_MILESTONES[tvPokeCount];
  if (mi !== undefined) phrase = TV_PHRASES[30 + mi]; // 后 4 条为里程碑语
  else {
    // 普通池 = 前 30 条，随机且不与上一条相同
    let idx;
    do { idx = Math.floor(Math.random() * 30); } while (idx === tvLastPhraseIdx && TV_PHRASES.length > 1);
    tvLastPhraseIdx = idx;
    phrase = TV_PHRASES[idx];
  }
  bubble.textContent = phrase;
  bubble.classList.remove("out", "hidden");
  // 位置随机微调，避免单调
  bubble.style.left = `${46 + Math.random() * 24}%`;
  bubble.style.top = `${Math.random() * 10}%`;
  clearTimeout(tvBubbleTimer);
  tvBubbleTimer = setTimeout(() => {
    bubble.classList.add("out");
    setTimeout(() => bubble.classList.add("hidden"), 260);
  }, 1800);
}
function openTomato() {
  if (tvOpen) return;
  tvOpen = true;
  tvClosing = false;
  const v = $("tomatoView");
  v.classList.remove("closing", "hidden"); // 若退出动画被打断，恢复初始状态
  render();
}
function closeTomato() {
  if (!tvOpen || tvClosing) return;
  tvOpen = false;
  tvClosing = true;
  const v = $("tomatoView");
  v.classList.add("closing");
  const finish = () => {
    v.removeEventListener("animationend", onEnd);
    v.classList.add("hidden");
    v.classList.remove("closing");
    tvClosing = false;
  };
  const onEnd = (e) => { if (e.target === v) finish(); };
  v.addEventListener("animationend", onEnd);
  setTimeout(() => { if (tvClosing) finish(); }, 600); // 动画事件丢失时兜底
}

/* ---------- 等级页面（顶栏等级入口） ----------
   只读展示「全部等级 + 到达每一级所需经验」。
   刻意不碰任何等级逻辑：所有数值都直接取自 xpNeeded() / levelOf() / xp()，
   等级公式、等级名、等级卡片的表现都保持原样。 */
const LV_MAX = LEVEL_CAP; // 与 levelOf() 上限共用同一常量，避免两处不一致
let lvOpen = false, lvClosing = false;

/* 行内已有等级数字，页内只显示纯名字（不再拼接 Lv.N，避免「Lv.20 达人 Lv.20」） */
function levelCatalogName(lv) { return LEVEL_NAMES[lv - 1] || `Lv.${lv}`; }

function renderLevelPage() {
  const x = xp(), lv = levelOf(x);
  const base = xpNeeded(lv);
  // LEVEL_CAP 是上限：满级时不存在「下一级」，不能沿用 xpNeeded(cap+1)
  // 造出一个不存在的假阈值（否则进度条永远差一截、文案会写出 Lv.101）
  const maxed = lv >= LV_MAX;
  const next = maxed ? base : xpNeeded(lv + 1);
  const pct = maxed ? 100 : next > base ? Math.min(100, ((x - base) / (next - base)) * 100) : 100;

  $("levelNow").innerHTML = `
    <div class="lv-now-badge">${lv}</div>
    <div class="lv-now-meta">
      <div class="lv-now-name">Lv.${lv} ${esc(levelCatalogName(lv))}</div>
      <div class="lv-now-xp">${maxed
        ? `累计 ${x} XP · 已达最高等级 🎉`
        : `${x} / ${next} XP · 还差 ${Math.max(0, next - x)} XP 升级`}</div>
      <div class="lv-now-track"><div class="lv-now-fill" style="width:${pct}%"></div></div>
    </div>`;

  const rows = [];
  for (let n = 1; n <= LV_MAX; n++) {
    const need = xpNeeded(n);                       // 到达第 n 级的累计经验
    const step = n <= 1 ? 0 : need - xpNeeded(n - 1); // 从上一级到本级所需的增量
    const state = n === lv ? "now" : n < lv ? "done" : "";
    const tag = n === lv ? '<span class="lv-row-tag now">当前</span>'
      : n < lv ? '<span class="lv-row-tag done">已达成</span>' : "";
    rows.push(`<div class="lv-row ${state}">
      <div class="lv-row-badge">${n}</div>
      <div class="lv-row-name">${esc(levelCatalogName(n))}${tag}</div>
      <div class="lv-row-xp">${need.toLocaleString()} XP<small>${n <= 1 ? "起点" : "+" + step.toLocaleString() + " XP"}</small></div>
    </div>`);
  }
  $("levelList").innerHTML = rows.join("");
  $("levelListNote").textContent = `共 ${LV_MAX} 级`;
}

/* 当前等级可能在第 40 级开外，打开后把它带到视野里。
   注意：只在「确实看不见」时才滚动。早先无条件居中，低等级会滚出几十像素，
   结果概览卡片被吸顶表头切成一半，看起来像渲染坏了。 */
function scrollLevelToCurrent() {
  const view = $("levelView");
  const row = view.querySelector(".lv-row.now");
  if (!row) return;
  const head = view.querySelector(".lv-head");
  const headH = head ? head.offsetHeight : 0;
  const vr = view.getBoundingClientRect(), rr = row.getBoundingClientRect();
  const top = vr.top + headH + 8;            // 表头下方的安全边界
  const bottom = vr.bottom - 8;
  if (rr.top >= top && rr.bottom <= bottom) return; // 已经完整可见 → 不动
  view.scrollTop += rr.top - top;             // 否则贴到表头下方
}

function openLevelPage() {
  if (lvOpen) return;
  lvOpen = true; lvClosing = false;
  renderLevelPage();
  const v = $("levelView");
  v.classList.remove("closing", "hidden"); // 若上次退出动画被打断，先恢复初始状态
  v.scrollTop = 0;
  requestAnimationFrame(() => {
    scrollLevelToCurrent();
    $("levelBackBtn").focus({ preventScroll: true });
  });
}

function closeLevelPage() {
  if (!lvOpen || lvClosing) return;
  lvOpen = false; lvClosing = true;
  const v = $("levelView");
  const finish = () => {
    v.removeEventListener("animationend", onEnd);
    v.classList.add("hidden");
    v.classList.remove("closing");
    lvClosing = false;
  };
  const onEnd = (e) => { if (e.target === v) finish(); };
  if (JR_REDUCED) { finish(); return; }
  v.classList.add("closing");
  v.addEventListener("animationend", onEnd);
  setTimeout(() => { if (lvClosing) finish(); }, 500); // 动画事件丢失时兜底
}

/* ---------- 模式弹窗 ---------- */
const PALETTE = ["#ef4444", "#f59e0b", "#eab308", "#10b981", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"];
let editingMode = null, pickedColor = PALETTE[0];
let modeCloseGen = 0; // 关闭动画代号：重新打开时使待执行的隐藏失效

function openModeModal(mode) {
  modeCloseGen++; // 取消进行中的关闭动画
  KPapi.close(); // 收起取色面板
  editingMode = mode || null;
  $("modeModalTitle").textContent = mode ? "编辑模式" : "添加模式";
  $("modeNameInput").value = mode ? mode.name : "";
  $("modeFocusInput").value = mode ? mode.focus : 25;
  $("modeBreakInput").value = mode ? mode.brk : 5;
  pickedColor = mode ? mode.color : PALETTE[store.modes.length % PALETTE.length];
  $("deleteModeBtn").classList.toggle("hidden", !mode || !mode.custom);
  renderPalette();
  const m = $("modeModal");
  m.classList.remove("closing", "hidden");
  setTimeout(() => $("modeNameInput").focus(), 50);
}
function renderPalette() {
  const picked = pickedColor.toLowerCase();
  const inPalette = PALETTE.some((c) => c.toLowerCase() === picked);
  $("colorPicks").innerHTML =
    PALETTE.map((c) =>
      `<div class="color-dot${c.toLowerCase() === picked ? " active" : ""}" data-c="${c}" style="background:${c}" title="${c}"></div>`
    ).join("") +
    // 自定义色点：显示当前色，点击展开/收起 Kibo 取色面板
    `<button type="button" class="color-dot color-dot-custom${inPalette ? "" : " active"}" id="customColorDot"
       style="${inPalette ? "" : `background:${pickedColor}`}" title="自定义取色器" aria-expanded="${typeof KP !== "undefined" && KP.open ? "true" : "false"}">
       <span class="color-dot-custom-ico">${inPalette ? "🎨" : ""}</span>
     </button>`;
  $("colorPicks").querySelectorAll(".color-dot[data-c]").forEach((el) => {
    el.onclick = () => { pickedColor = el.dataset.c; renderPalette(); };
  });
  $("customColorDot").onclick = () => KPapi.toggle();
}

/* ---------- Kibo UI 风格取色器（HSL 模型，仿 Figma） ---------- */
const KP = { h: 0, s: 100, l: 50, a: 100, open: false, dragging: null, outside: null,
             captured: undefined, scrollTarget: null, onScroll: null };

// 颜色转换
function kpHslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
function kpRgbToHex(r, g, b, a = 100) {
  const hex = [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  return a >= 100 ? `#${hex}` : `#${hex}${Math.round((a / 100) * 255).toString(16).padStart(2, "0")}`;
}
function kpHexToHsl(hex) {
  hex = hex.replace("#", "");
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: s * 100, l: l * 100 };
}
function kpCurrentHex() {
  const [r, g, b] = kpHslToRgb(KP.h, KP.s, KP.l);
  return kpRgbToHex(r, g, b, KP.a);
}

const KPapi = {
  init() {
    const sel = $("kpSelection");
    const hue = $("kpHue");
    const alpha = $("kpAlpha");

    /* 拖动跟踪
       根因：旧实现只在滑块自身监听 pointerup/pointercancel。一旦指针在滑块之外松开
       （手机上很常见：手指滑出色条后抬起，或系统打断），KP.dragging 不会被清空，
       之后鼠标/手指「只是划过」色条就会继续改色 —— 看上去就是误触。
       修复：指针捕获 + 在 window 上兜底监听 pointerup/pointercancel，确保一定收尾。*/
    const endDrag = () => {
      if (!KP.dragging) return;
      const el = KP.dragging;
      KP.dragging = null;
      const id = KP.captured;
      KP.captured = undefined;
      if (id !== undefined) { try { el.releasePointerCapture(id); } catch (_) {} }
    };
    const track = (el, fn) => {
      el.addEventListener("pointerdown", (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        KP.dragging = el;
        KP.captured = e.pointerId;
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
        fn(e);
      });
      el.addEventListener("pointermove", (e) => {
        if (KP.dragging !== el) return;
        if (KP.captured !== undefined && e.pointerId !== KP.captured) return;
        e.preventDefault();
        fn(e);
      });
      // 指针在元素外松开时，pointerup 会派发到捕获元素；pointercancel 覆盖系统打断
      el.addEventListener("pointerup", endDrag);
      el.addEventListener("pointercancel", endDrag);
      el.addEventListener("lostpointercapture", endDrag);
      // 桌面上鼠标移出后松开：兜底立即结束拖动状态
      el.addEventListener("pointerleave", (e) => {
        if (KP.dragging === el && e.buttons === 0) endDrag();
      });
    };
    // 全局兜底：任何地方松开都结束拖动（防止 dragging 卡住导致后续划过改色）
    window.addEventListener("pointerup", endDrag, true);
    window.addEventListener("pointercancel", endDrag, true);
    window.addEventListener("blur", endDrag);

    const pos = (e, el) => {
      const r = el.getBoundingClientRect();
      return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
              Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
    };

    // 横条类控件只关心横向位置；纵向漂移不该改色（手指略微上下移动很常见）
    const posX = (e, el) => pos(e, el)[0];

    // 饱和度 / 亮度方块（kibo: saturation = x*100, lightness = topL*(1-y)）
    track(sel, (e) => {
      const [x, y] = pos(e, sel);
      KP.s = x * 100;
      const topL = x < 0.01 ? 100 : 50 + 50 * (1 - x);
      KP.l = topL * (1 - y);
      this.sync();
    });
    // 色相条 / 透明度条：只取横向比例，避免纵向抖动改色
    track(hue, (e) => { KP.h = posX(e, hue) * 360; this.sync(); });
    track(alpha, (e) => { KP.a = posX(e, alpha) * 100; this.sync(); });

    // HEX 输出可编辑
    $("kpHex").addEventListener("change", (e) => {
      const v = e.target.value.trim();
      if (!/^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) { this.sync(); return; }
      this.setColor(v.startsWith("#") ? v : `#${v}`, true);
    });

    // 吸管（EyeDropper API，实验性）
    $("kpEyedropper").onclick = async () => {
      if (!("EyeDropper" in window)) { toast("当前浏览器不支持屏幕取色"); return; }
      try {
        const res = await new EyeDropper().open();
        this.setColor(res.sRGBHex, true);
      } catch (_) { /* 用户取消 */ }
    };

    // 确认按钮：应用草稿色
    $("kpConfirm").onclick = () => this.confirm();

    if ("EyeDropper" in window) $("kpEyedropper").classList.add("has-eyedropper");
  },

  setColor(hex) {
    hex = hex.toLowerCase();
    if (hex.length === 9) { KP.a = Math.round((parseInt(hex.slice(7, 9), 16) / 255) * 100); hex = hex.slice(0, 7); }
    else KP.a = 100;
    const { h, s, l } = kpHexToHsl(hex);
    KP.h = h; KP.s = s; KP.l = l;
    this.sync();
  },

  // 拖动/输入仅在面板内预览，不写入 pickedColor
  sync() {
    const hex6 = `#${kpHslToRgb(KP.h, KP.s, KP.l).map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    // 方块底色：黑→透明（纵）、白→透明（横）+ 纯色
    $("kpSelection").style.background =
      `linear-gradient(0deg, rgba(0,0,0,1), rgba(0,0,0,0)), linear-gradient(90deg, rgba(255,255,255,1), rgba(255,255,255,0)), hsl(${KP.h}, 100%, 50%)`;
    // 方块游标：x = s/100，y 由亮度反推
    const topL = KP.s < 1 ? 100 : 50 + 50 * (1 - KP.s / 100);
    const y = topL > 0 ? 1 - KP.l / topL : 0;
    const thumb = $("kpSelThumb");
    thumb.style.left = `${KP.s}%`;
    thumb.style.top = `${Math.min(1, Math.max(0, y)) * 100}%`;
    thumb.style.background = `hsl(${KP.h}, ${KP.s}%, ${KP.l}%)`;
    // 色相条游标
    $("kpHueThumb").style.left = `${(KP.h / 360) * 100}%`;
    // 透明度条（左实右虚）
    $("kpAlphaFill").style.background =
      `linear-gradient(90deg, ${hex6}, ${hex6}00), repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 0 / 12px 12px`;
    $("kpAlphaThumb").style.left = `${KP.a}%`;
    $("kpAlphaThumb").style.background = `rgba(${kpHslToRgb(KP.h, KP.s, KP.l).join(",")}, ${KP.a / 100})`;
    // 输出预览（草稿色）
    const draft = kpCurrentHex();
    $("kpHex").value = draft;
    $("kpPreview").style.background = draft;
  },

  // 确认：草稿色写入 pickedColor 并同步调色板，收起面板
  confirm() {
    pickedColor = kpCurrentHex();
    renderPalette();
    this.toggle(false);
    toast(`已应用颜色 ${pickedColor}`);
  },

  toggle(force) {
    const panel = $("kiboPicker");
    KP.open = force !== undefined ? force : !KP.open;
    panel.classList.toggle("hidden", !KP.open);
    const dot = $("customColorDot");
    if (dot) dot.setAttribute("aria-expanded", String(KP.open));
    if (KP.open && dot) {
      this.reposition();
      this.setColor(pickedColor);
      this.sync();
      // 弹窗滚动 / 窗口尺寸变化时跟随色点，否则面板会「飘」到保存按钮上把点击吃掉
      KP.scrollTarget = dot.closest(".modal");
      KP.onScroll = () => this.reposition();
      if (KP.scrollTarget) KP.scrollTarget.addEventListener("scroll", KP.onScroll, { passive: true });
      window.addEventListener("resize", KP.onScroll);
      window.addEventListener("scroll", KP.onScroll, { passive: true, capture: true });
      // 点击外部自动收起（延迟绑定，避免点色点本身误关）
      setTimeout(() => {
        KP.outside = (e) => {
          // 每次实时查询色点：renderPalette() 会重建色点 DOM，闭包里的旧引用会失效
          const cur = $("customColorDot");
          if (!panel.contains(e.target) && !(cur && cur.contains(e.target))) {
            KPapi.close();
          }
        };
        document.addEventListener("pointerdown", KP.outside, true);
      }, 0);
    } else {
      this.detach();
    }
  },

  /* 跟随色点重新定位。
     约束：面板绝不能盖住弹窗底部的「保存/取消」——色点上方或下方若只按视口空间
     判断，面板会正好压在操作区上，用户点保存就像没反应。 */
  reposition() {
    const panel = $("kiboPicker");
    const dot = $("customColorDot");
    if (!KP.open || !dot || !panel) return;
    const r = dot.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = Math.min(300, vw - 24);
    panel.style.width = pw + "px";
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(12, Math.min(left, vw - pw - 12));
    panel.style.left = `${left}px`;
    const arrowX = Math.max(16, Math.min(r.left + r.width / 2 - left - 7, pw - 30));
    panel.style.setProperty("--kp-arrow-x", `${arrowX}px`);

    const ph = panel.offsetHeight;
    // 弹窗操作区：面板若与之相交，就换到另一侧
    const actions = document.querySelector("#modeModal .modal-actions");
    const act = actions ? actions.getBoundingClientRect() : null;
    const gap = 10;

    const fitsBelow = r.bottom + gap + ph <= vh - 12;
    const fitsAbove = r.top - gap - ph >= 12;

    const overlapsActions = (top) => !!act && top < act.bottom && top + ph > act.top;
    const belowTop = r.bottom + gap;
    const aboveTop = r.top - gap - ph;

    let mode;
    if (fitsBelow && !overlapsActions(belowTop)) mode = "below";
    else if (fitsAbove && !overlapsActions(aboveTop)) mode = "above";
    else if (fitsBelow && fitsAbove) mode = overlapsActions(belowTop) ? "above" : "below";
    else if (fitsBelow) mode = "below";
    else if (fitsAbove) mode = "above";
    else mode = null;

    if (mode === "below") {
      panel.style.top = `${belowTop}px`;
      panel.dataset.arrow = "top";
    } else if (mode === "above") {
      panel.style.top = `${aboveTop}px`;
      panel.dataset.arrow = "bottom";
    } else {
      // 上下都被操作区占住（矮屏）：贴视口，同时保证不压住操作区
      let top = Math.max(12, Math.min(belowTop, vh - ph - 12));
      if (overlapsActions(top)) {
        top = act.top - gap - ph;
        if (top < 12) top = Math.min(vh - ph - 12, act.bottom + gap);
        top = Math.max(12, top);
      }
      panel.style.top = `${top}px`;
      panel.dataset.arrow = top < r.top ? "bottom" : "top";
    }
  },

  detach() {
    if (KP.scrollTarget && KP.onScroll) KP.scrollTarget.removeEventListener("scroll", KP.onScroll);
    if (KP.onScroll) {
      window.removeEventListener("resize", KP.onScroll);
      window.removeEventListener("scroll", KP.onScroll, { capture: true });
    }
    KP.scrollTarget = null; KP.onScroll = null;
    if (KP.outside) {
      document.removeEventListener("pointerdown", KP.outside, true);
      KP.outside = null;
    }
  },

  close() { if (KP.open) this.toggle(false); },
};
function closeModeModal() {
  const m = $("modeModal");
  KPapi.close(); // 收起取色面板
  editingMode = null;
  if (m.classList.contains("hidden")) return;
  if (JR_REDUCED) { m.classList.add("hidden"); return; }
  // 播放关闭动画（淡出 + 下滑），结束后再隐藏
  const gen = ++modeCloseGen;
  m.classList.add("closing");
  const finish = () => {
    if (gen !== modeCloseGen) return; // 已被重新打开，放弃隐藏
    m.removeEventListener("animationend", onEnd);
    m.classList.add("hidden");
    m.classList.remove("closing");
  };
  const onEnd = (e) => { if (e.target === m) finish(); };
  m.addEventListener("animationend", onEnd);
  setTimeout(finish, 400); // 动画事件丢失时兜底
}

/* 校验失败反馈：给输入框描红 + 轻微闪一下，并聚焦第一个出错的框。
   用「代号」防串扰：重复点击保存时，前一次的清理回调/动画监听不能把
   后一次刚加上的红框提前清掉（否则连点两下红框会中途消失）。 */
const invalidGen = new WeakMap();
function flagInvalid(el) {
  if (!el) return;
  const gen = (invalidGen.get(el) || 0) + 1;
  invalidGen.set(el, gen);
  el.classList.remove("field-error");
  void el.offsetWidth; // 强制重排，让动画能重复播放
  el.classList.add("field-error");
  el.setAttribute("aria-invalid", "true");
  const clear = () => {
    if (invalidGen.get(el) !== gen) return; // 已被更新的调用接管
    el.classList.remove("field-error");
    el.removeAttribute("aria-invalid");
  };
  el.addEventListener("animationend", clear, { once: true });
  setTimeout(clear, 1600); // 动画事件丢失时兜底
}

function saveMode() {
  const name = ($("modeNameInput").value || "").trim().slice(0, 8);
  const focusEl = $("modeFocusInput");
  const brkEl = $("modeBreakInput");
  const focusRaw = parseInt(focusEl.value, 10);
  const brkRaw = parseInt(brkEl.value, 10);

  // 0 / 空 / 非数字 都算无效：专注与休息必须 ≥ 1 分钟
  const bad = [];
  if (!Number.isFinite(focusRaw) || focusRaw < 1) bad.push(focusEl);
  if (!Number.isFinite(brkRaw) || brkRaw < 1) bad.push(brkEl);
  if (bad.length) {
    bad.forEach(flagInvalid);
    bad[0].focus();
    toast("专注和休息都必须大于 0 分钟", { desc: "已用红框标出需要修改的输入框" });
    return;
  }
  if (!name) { flagInvalid($("modeNameInput")); $("modeNameInput").focus(); toast("请输入模式名称"); return; }

  const focus = Math.min(180, focusRaw);
  const brk = Math.min(60, brkRaw);
  focusEl.value = focus;
  brkEl.value = brk;
  if (editingMode) {
    Object.assign(editingMode, { name, focus, brk, color: pickedColor });
    toast("模式已更新");
  } else {
    const m = { id: "c-" + Date.now().toString(36), name, focus, brk, color: pickedColor, custom: true };
    store.modes.push(m);
    store.activeModeId = m.id;
    T.phase = "focus"; T.status = "idle"; T.remaining = focus * 60000; T.focusMs = 0;
    toast(`已添加「${name}」模式 🍅`);
  }
  save(); closeModeModal(); refreshAll();
}
function deleteMode() {
  if (!editingMode || !editingMode.custom) return;
  store.modes = store.modes.filter((m) => m.id !== editingMode.id);
  if (store.activeModeId === editingMode.id) { store.activeModeId = store.modes[0].id; setPhase("focus"); }
  save(); closeModeModal(); refreshAll();
  toast("模式已删除");
}

/* ---------- 通用确认弹窗 ----------
   不用原生 confirm()：Chrome 在用户勾选「阻止此页面创建更多对话框」后会静默返回
   false，导致「点了清空却没反应」，且没有任何提示。自绘弹窗不受该抑制影响。 */
let confirmResolve = null;
function askConfirm(text, { okText = "确定", title = "确认", danger = false } = {}) {
  return new Promise((resolve) => {
    // 已有未决确认：先把上一个当成取消，避免 Promise 永久挂起
    if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
    confirmResolve = resolve;
    $("confirmTitle").textContent = title;
    $("confirmText").textContent = text;
    const ok = $("confirmOkBtn");
    ok.textContent = okText;
    ok.classList.toggle("btn-danger", danger);
    ok.classList.toggle("btn-primary", !danger);
    $("confirmModal").classList.remove("hidden");
    setTimeout(() => ok.focus(), 30);
  });
}
function settleConfirm(val) {
  const r = confirmResolve;
  confirmResolve = null;
  const m = $("confirmModal");
  if (m && !m.classList.contains("hidden")) m.classList.add("hidden");
  if (r) r(val);
}

/* ---------- 设置弹窗 ---------- */
function openSettings() {
  const s = store.settings;
  $("setSound").checked = s.sound;
  $("setAutoBreak").checked = s.autoBreak;
  $("setAutoFocus").checked = s.autoFocus;
  $("setWake").checked = s.wake;
  $("setGoal").value = s.dailyGoal || 8;
  $("setDark").checked = store.settings.theme === "dark";
  $("setSync").checked = !!s.syncOn;
  $("syncKeyInput").value = s.syncKey || "";
  SYNC.renderStatus();
  $("settingsModal").classList.remove("hidden");
}
function closeSettings() {
  store.settings.dailyGoal = Math.min(50, Math.max(0, parseInt($("setGoal").value, 10) || 8));
  save(); closeSettingsModal(); refreshAll();
}
function closeSettingsModal() {
  const m = $("settingsModal");
  if (m.classList.contains("hidden")) return;
  if (JR_REDUCED) { m.classList.add("hidden"); return; }
  // 播放关闭动画（淡出 + 下滑），结束后再隐藏
  m.classList.add("closing");
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    m.removeEventListener("animationend", onEnd);
    m.classList.add("hidden");
    m.classList.remove("closing");
  };
  const onEnd = (e) => { if (e.target === m) finish(); };
  m.addEventListener("animationend", onEnd);
  setTimeout(finish, 400); // 动画事件丢失时兜底
}

/* ---------- 主题（Animated Theme Toggler：View Transitions 圆形揭示） ---------- */
const VT_DURATION = 400;

function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  $("themeBtn").textContent = t === "dark" ? "☀️" : "🌙";
  document.querySelector('meta[name="theme-color"]').setAttribute("content", t === "dark" ? "#0c0e14" : "#f4f5fa");
}

// clip-path 片段：百分比坐标，兼容缩放显示（magicui 同款算法）
function vtClipPaths(cx, cy, maxRadius, vw, vh) {
  const px = (x) => `${(x / vw) * 100}%`;
  const py = (y) => `${(y / vh) * 100}%`;
  // circle() 百分比半径按 hypot(w,h)/√2 解析
  const pr = (r) => `${(r / (Math.hypot(vw, vh) / Math.SQRT2)) * 100}%`;
  return [
    `circle(0% at ${px(cx)} ${py(cy)})`,
    `circle(${pr(maxRadius)} at ${px(cx)} ${py(cy)})`,
  ];
}

function toggleTheme() {
  const root = document.documentElement;
  if (root.dataset.vtActive) return; // 动画进行中，忽略重复点击

  const next = store.settings.theme === "dark" ? "light" : "dark";
  const apply = () => { store.settings.theme = next; save(); applyTheme(next); };

  // 不支持 View Transitions 或用户偏好减少动效 → 直接切换
  if (typeof document.startViewTransition !== "function" || JR_REDUCED) { apply(); return; }

  // 从主题按钮中心扩散
  const btn = $("themeBtn").getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const cx = btn.left + btn.width / 2;
  const cy = btn.top + btn.height / 2;
  const maxRadius = Math.hypot(Math.max(cx, vw - cx), Math.max(cy, vh - cy));
  const clip = vtClipPaths(cx, cy, maxRadius, vw, vh);

  root.dataset.vtActive = "1";
  root.style.setProperty("--vt-duration", `${VT_DURATION}ms`);
  root.style.setProperty("--vt-clip-from", clip[0]); // 快照前先钉住收缩态，避免闪现新主题

  let anim = null;
  const cleanup = () => {
    delete root.dataset.vtActive;
    root.style.removeProperty("--vt-duration");
    root.style.removeProperty("--vt-clip-from");
    if (anim) { try { anim.cancel(); } catch (_) {} }
  };

  const transition = document.startViewTransition(() => apply());
  if (transition.finished && typeof transition.finished.finally === "function") {
    transition.finished.finally(cleanup).catch(() => {});
  } else {
    setTimeout(cleanup, VT_DURATION + 120);
  }
  if (transition.ready && typeof transition.ready.then === "function") {
    transition.ready
      .then(() => {
        anim = root.animate(
          { clipPath: clip },
          {
            duration: VT_DURATION,
            easing: "ease-in-out",
            fill: "forwards",
            pseudoElement: "::view-transition-new(root)",
          }
        );
      })
      .catch(() => {});
  }
}

/* ---------- Swipe Toast（可下滑关闭的提示，motion 驱动） ---------- */
const ST_CFG = {
  EASE_OUT: [0.23, 1, 0.32, 1],
  FLICK: 0.11,          // 甩动速度阈值 px/ms
  DEAD_ZONE: 3,
  RESIST_PX: 24,        // 上滑回弹阻尼
  SWIPE_DISTANCE: 40,   // 下滑关闭距离
  SLIDE: 400,
  EXIT: 0.7,
};
const ST_CLOSE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18 6L6.00081 17.9992M17.9992 18L6 6.00085" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2"/></svg>';

const stRubber = (over, dim, c = 0.55) => (over * dim * c) / (dim + c * Math.abs(over));
const stVelocity = (hist) => {
  if (hist.length < 2) return 0;
  const [t0, y0] = hist[0];
  const [t1, y1] = hist[hist.length - 1];
  return performance.now() - t1 > 100 ? 0 : (y1 - y0) / Math.max(1, t1 - t0);
};

function toast(msg, opts = {}) {
  const title = typeof msg === "string" ? msg : (msg && msg.title) || "";
  const desc = opts.desc || "";
  const duration = opts.duration ?? 3500;
  const swipeDistance = opts.swipeDistance ?? ST_CFG.SWIPE_DISTANCE;
  const pauseOnHover = opts.pauseOnHover !== false;
  const reduce = JR_REDUCED;

  const el = document.createElement("div");
  el.className = "swipe-toast";
  el.dataset.phase = "open";
  el.dataset.mounted = "false";
  el.dataset.fuse = duration > 0 ? "bottom" : "none";
  el.innerHTML =
    '<div class="swipe-toast__gate"><div class="swipe-toast__lift">' +
    `<div class="swipe-toast__card" role="status" aria-live="polite" aria-atomic="true" tabindex="0">` +
    `<span class="swipe-toast__body"><span class="swipe-toast__title"></span>` +
    (desc ? '<span class="swipe-toast__desc"></span>' : "") +
    `</span>` +
    `<button type="button" class="swipe-toast__close" aria-label="关闭">${ST_CLOSE_SVG}</button>` +
    `<i class="swipe-toast__fuse" aria-hidden="true"></i>` +
    `</div></div></div>`;
  el.querySelector(".swipe-toast__title").textContent = title;
  if (desc) el.querySelector(".swipe-toast__desc").textContent = desc;

  const wrap = $("toastWrap");
  wrap.appendChild(el);
  // 入场：mounted false → true 触发 lift 上滑淡入
  requestAnimationFrame(() => requestAnimationFrame(() => { el.dataset.mounted = "true"; }));

  const card = el.querySelector(".swipe-toast__card");
  const fuseEl = el.querySelector(".swipe-toast__fuse");
  const closeBtn = el.querySelector(".swipe-toast__close");

  let phase = "open";
  let leaving = false;
  let drag = null;
  let pendingClose = null;
  const flags = { hover: false, interacting: false, focus: false, hidden: document.hidden };

  // y 位移 / 透明度：motion MotionValue 驱动
  const mkMV = (init, apply) => {
    if (JR_MOTION) {
      const mv = new JR_MOTION.MotionValue(init);
      mv.on("change", apply);
      return mv;
    }
    let v = init;
    return { get: () => v, set: (n) => { v = n; apply(n); }, stop() {}, on() {} };
  };
  const y = mkMV(0, (v) => { card.style.transform = `translateY(${v}px)`; });
  const fade = mkMV(1, (n) => { card.style.opacity = n; });

  // 引信倒计时（WAAPI scaleX 燃烧）
  let fuseAnim = null;
  const syncFuse = () => {
    if (!fuseAnim) return;
    if (flags.hover || flags.interacting || flags.focus || flags.hidden) fuseAnim.pause();
    else if (fuseAnim.playState === "paused") fuseAnim.play();
  };
  const finish = () => {
    phase = "gone";
    leaving = false;
    el.dataset.phase = "gone";
    document.removeEventListener("visibilitychange", onVisibility);
    setTimeout(() => el.remove(), 220);
  };
  const onVisibility = () => {
    flags.hidden = document.hidden;
    syncFuse();
  };
  const close = () => {
    if (phase !== "open" || leaving) return;
    if (drag) { pendingClose = true; return; }
    leaving = true;
    phase = "closing";
    if (fuseAnim) fuseAnim.pause();
    el.dataset.phase = "closing";
    setTimeout(finish, ST_CFG.SLIDE * ST_CFG.EXIT + 60);
  };

  if (duration > 0 && !reduce) {
    try {
      fuseAnim = fuseEl.animate(
        [{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }],
        { duration, easing: "linear", fill: "forwards" }
      );
      fuseAnim.onfinish = () => close();
    } catch (e) { setTimeout(close, duration); }
  } else if (duration > 0) {
    setTimeout(close, duration); // reduced-motion：仅定时关闭
  }

  const swipeOut = (dy, v) => {
    leaving = true;
    pendingClose = null;
    if (JR_MOTION && !reduce) {
      JR_MOTION.animate(y, dy + card.offsetHeight + 24, { type: "spring", duration: 0.3, bounce: 0, velocity: v * 1000 });
      JR_MOTION.animate(fade, 0, { duration: 0.18, ease: ST_CFG.EASE_OUT });
    } else {
      card.style.opacity = "0";
    }
    setTimeout(finish, 260);
  };

  const onDown = (e) => {
    if (e.button !== 0 || leaving || e.target.closest("button")) return;
    try { card.setPointerCapture(e.pointerId); } catch (_) {}
    if (JR_MOTION) { y.stop(); fade.stop(); }
    drag = { id: e.pointerId, startY: e.clientY, grab: null, moved: false, hist: [[performance.now(), y.get()]] };
    flags.interacting = true;
    syncFuse();
  };
  const onMove = (e) => {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    if (d.grab === null) {
      if (Math.abs(e.clientY - d.startY) < ST_CFG.DEAD_ZONE) return;
      d.grab = e.clientY - y.get();
      card.dataset.swiping = "";
    }
    const raw = e.clientY - d.grab;
    const next = raw >= 0 ? raw : stRubber(raw, ST_CFG.RESIST_PX);
    y.set(next);
    // 下滑越多越淡，给出明确的“拖走”反馈；上拉（负值）不加淡出
    if (!reduce) {
      const h = card.offsetHeight || 1;
      fade.set(Math.max(0.35, 1 - Math.max(0, next) / (h * 1.4)));
    }
    d.moved = true;
    d.hist.push([performance.now(), next]);
    if (d.hist.length > 6) d.hist.shift();
  };
  const onUp = (e) => {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    drag = null;
    delete card.dataset.swiping;
    try { card.releasePointerCapture(e.pointerId); } catch (_) {}
    flags.interacting = false;
    const dy = y.get();
    const v = stVelocity(d.hist);
    const h = card.offsetHeight || 1;
    // 判定：向下甩动（速度够快且已下移），或拖过卡片高度 40%
    const passed = dy > 0 && (dy >= swipeDistance && v >= 0);
    const flicked = dy > 0 && v > ST_CFG.FLICK;
    const deepDrag = dy >= h * 0.4;
    if (flicked || passed || deepDrag) {
      swipeOut(dy, v);
      return;
    }
    if (d.moved) {
      if (JR_MOTION) {
        JR_MOTION.animate(y, 0, reduce
          ? { duration: 0.2, ease: ST_CFG.EASE_OUT }
          : { type: "spring", duration: 0.5, bounce: 0.2, velocity: v * 1000 });
        JR_MOTION.animate(fade, 1, reduce
          ? { duration: 0.2, ease: ST_CFG.EASE_OUT }
          : { type: "spring", duration: 0.5, bounce: 0.2, velocity: v * 1000 });
      } else { y.set(0); fade.set(1); }
    }
    if (pendingClose) { pendingClose = false; close(); }
    else syncFuse();
  };

  card.addEventListener("pointerdown", onDown);
  card.addEventListener("pointermove", onMove);
  card.addEventListener("pointerup", onUp);
  card.addEventListener("pointercancel", onUp);
  card.addEventListener("lostpointercapture", onUp);
  card.addEventListener("pointerenter", (e) => { if (pauseOnHover && e.pointerType === "mouse") { flags.hover = true; syncFuse(); } });
  card.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { flags.hover = false; syncFuse(); } });
  card.addEventListener("focus", () => { flags.focus = true; syncFuse(); });
  card.addEventListener("blur", (e) => { if (!card.contains(e.relatedTarget)) { flags.focus = false; syncFuse(); } });
  card.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  });
  closeBtn.addEventListener("click", () => close());

  document.addEventListener("visibilitychange", onVisibility);
}

/* ---------- ☁️ 跨设备同步（Cloudflare Pages Functions + KV） ---------- */
const SYNC = {
  url: "/api/data",
  pushTimer: 0,
  busy: false,

  on() { return !!store.settings.syncOn && !!store.settings.syncKey; },

  status(msg) {
    const el = $("syncStatus");
    if (el) el.textContent = msg;
  },

  // 本地改动 → 防抖 2s 推送云端
  schedulePush() {
    if (!this.on()) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.push(), 2000);
  },

  async push(silent) {
    if (!this.on() || this.busy) return false;
    this.busy = true;
    if (!silent) this.status("⏳ 上传中…");
    try {
      const res = await fetch(`${this.url}?key=${encodeURIComponent(store.settings.syncKey)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(store),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.status(`☁️ 已同步 · ${new Date().toLocaleTimeString()}`);
      if (!silent) toast("已上传到云端");
      return true;
    } catch (e) {
      this.status("⚠️ 同步失败，稍后自动重试");
      return false;
    } finally {
      this.busy = false;
    }
  },

  // 启动/手动：拉取云端，按 updatedAt 最后写入者胜
  async pull(fromStartup) {
    if (!this.on()) return false;
    if (!fromStartup) this.status("⏳ 下载中…");
    try {
      const res = await fetch(`${this.url}?key=${encodeURIComponent(store.settings.syncKey)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const remote = await res.json();
      if (!remote || typeof remote !== "object") {
        // 云端为空 → 把本地推上去
        await this.push(true);
        this.status("☁️ 首次同步完成，云端已创建数据");
        return true;
      }
      const localTs = store.updatedAt || 0;
      const remoteTs = remote.updatedAt || 0;
      if (remoteTs > localTs) {
        // 云端较新：恢复云端版本
        store = Object.assign(loadDefaults(), remote);
        save();
        refreshAll();
        applyTheme(store.settings.theme);
        this.status(`☁️ 已拉取云端数据 · ${new Date(remoteTs).toLocaleString()}`);
        if (!fromStartup) toast("已从云端恢复数据");
        return true;
      } else {
        // 本地较新或相同 → 推本地
        await this.push(true);
        this.status(`☁️ 本地较新，已上传 · ${new Date().toLocaleTimeString()}`);
        return false;
      }
    } catch (e) {
      if (!fromStartup) { this.status("⚠️ 无法连接同步服务"); toast("同步失败，请检查网络"); }
      return false;
    }
  },

  generateKey() {
    const seg = () => Math.random().toString(36).slice(2, 8);
    return `tomato-${seg()}${seg()}${seg()}`;
  },

  // 设置面板接线
  bindUI() {
    $("setSync").onchange = (e) => {
      store.settings.syncOn = e.target.checked;
      if (e.target.checked && !store.settings.syncKey) {
        store.settings.syncKey = this.generateKey();
        $("syncKeyInput").value = store.settings.syncKey;
      }
      save();
      this.renderStatus();
      if (e.target.checked) this.pull(false);
    };
    $("syncGenBtn").onclick = () => {
      $("syncKeyInput").value = this.generateKey();
      toast("已生成新同步码，点「同步」生效");
    };
    $("syncSaveBtn").onclick = async () => {
      const key = $("syncKeyInput").value.trim();
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) { toast("同步码需 8-64 位字母/数字/-/_"); return; }
      const changed = key !== store.settings.syncKey;
      store.settings.syncKey = key;
      store.settings.syncOn = true;
      $("setSync").checked = true;
      save();
      this.renderStatus();
      if (changed) await this.pull(false); // 新码先拉（云端为空则自动上传本地）
      else await this.push(false);
    };
  },

  renderStatus() {
    if (!this.on()) { this.status("未开启同步"); return; }
    this.status(`☁️ 已开启 · 同步码：${store.settings.syncKey}`);
  },
};

function loadDefaults() {
  return {
    modes: DEFAULT_MODES.map((m) => ({ ...m })),
    activeModeId: "m-default",
    settings: { theme: "light", sound: true, autoBreak: false, autoFocus: false, wake: false, dailyGoal: 8 },
    sessions: [], interrupts: [], goalDay: "", quests: { days: {} }, questXp: 0, updatedAt: 0,
  };
}

/* ---------- 事件绑定 ---------- */
function bind() {
  $("mainBtn").onclick = () => {
    if (T.status === "running") pauseTimer();
    else if (T.status === "paused") stopSession();
    else startTimer();
  };
  $("resumeBtn").onclick = resumeTimer;
  $("resetBtn").onclick = resetTimer;
  $("skipBtn").onclick = skipPhase;
  $("interruptBtn").onclick = interruptPhase;

  // 升级任务：默认折叠，点击展开/收起
  $("taskToggle").onclick = () => {
    const panel = $("taskPanel"), btn = $("taskToggle");
    const open = !panel.classList.contains("open");
    panel.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(open));
    if (open) renderTasks(); // 展开后再渲染，行入场动画随展开播放
  };

  $("themeBtn").onclick = toggleTheme;
  $("statsJumpBtn").onclick = () => $("statsSection").scrollIntoView({ behavior: "smooth", block: "start" });
  $("settingsBtn").onclick = openSettings;
  $("brandLevel").onclick = openLevelPage;
  $("levelBackBtn").onclick = closeLevelPage;
  // 点两侧留白也能退出（点内容区不关，避免与滚动手势冲突）
  $("levelView").onclick = (e) => { if (e.target === $("levelView")) closeLevelPage(); };
  $("settingsCloseBtn").onclick = closeSettings;
  $("setSound").onchange = (e) => { store.settings.sound = e.target.checked; save(); if (e.target.checked) beep(false); };
  $("setDark").onchange = (e) => { store.settings.theme = e.target.checked ? "dark" : "light"; save(); applyTheme(store.settings.theme); };
  $("setAutoBreak").onchange = (e) => { store.settings.autoBreak = e.target.checked; save(); };
  $("setAutoFocus").onchange = (e) => { store.settings.autoFocus = e.target.checked; save(); };
  $("setWake").onchange = (e) => { store.settings.wake = e.target.checked; save(); if (!e.target.checked) releaseWake(); else if (T.status === "running") requestWake(); };
  /* 导出数据
     多路兜底：Blob 下载 → URL.createObjectURL 失败/被拦时退回 data: URL；
     同时给出可见反馈，避免「点了没反应」而用户无从判断。 */
  $("exportBtn").onclick = () => {
    let text;
    try { text = JSON.stringify(store, null, 2); }
    catch (e) { toast("导出失败：数据无法序列化"); return; }
    const fname = `tomato-data-${dayKey(Date.now())}.json`;
    const a = document.createElement("a");
    a.download = fname;
    a.rel = "noopener";
    let url = null;
    try {
      const blob = new Blob([text], { type: "application/json" });
      url = URL.createObjectURL(blob);
      a.href = url;
    } catch (e) {
      // 极端情况下 Blob/URL 不可用 → data: URL 兜底
      a.href = "data:application/json;charset=utf-8," + encodeURIComponent(text);
    }
    document.body.appendChild(a); // 部分浏览器要求节点在文档中才触发下载
    try { a.click(); } catch (e) {
      a.href = "data:application/json;charset=utf-8," + encodeURIComponent(text);
      try { a.click(); } catch (_) {
        document.body.removeChild(a);
        if (url) URL.revokeObjectURL(url);
        toast("导出失败，请检查浏览器下载权限");
        return;
      }
    }
    document.body.removeChild(a);
    if (url) setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(`已导出 ${fname}`, { desc: `${store.sessions.length} 条记录 · ${store.interrupts.length} 次中断` });
  };

  /* 清空全部记录：自绘确认弹窗（原生 confirm 可能被浏览器抑制而静默失败） */
  $("clearBtn").onclick = async () => {
    const ok = await askConfirm(
      `将删除 ${store.sessions.length} 条专注记录和 ${store.interrupts.length} 次中断记录。\n模式、设置与等级经验会保留。此操作不可撤销。`,
      { title: "清空全部记录", okText: "确认清空", danger: true }
    );
    if (!ok) return;
    store.sessions = []; store.interrupts = []; store.goalDay = "";
    HIST.sel.clear();
    save(); refreshAll(); toast("记录已清空");
  };

  /* 最近记录：展开 / 管理 / 全选 / 批量删除 */
  $("historyExpandBtn").onclick = () => { HIST.expanded = !HIST.expanded; renderHistory(); };
  $("historyManageBtn").onclick = () => setHistManage(!HIST.manage);
  $("historyAll").onchange = (e) => {
    const sorted = historySorted();
    const list = HIST.expanded ? sorted : sorted.slice(0, HIST_PREVIEW);
    if (e.target.checked) list.forEach((s) => HIST.sel.add(s.id));
    else HIST.sel.clear();
    renderHistory();
  };
  $("historyDeleteBtn").onclick = async () => {
    const n = HIST.sel.size;
    if (!n) return;
    const ok = await askConfirm(`确定删除选中的 ${n} 条记录吗？此操作不可撤销。`,
      { title: "删除记录", okText: `删除 ${n} 条`, danger: true });
    if (!ok) return;
    const removed = deleteHistoryIds(Array.from(HIST.sel));
    refreshAll();
    toast(`已删除 ${removed} 条记录`);
  };

  /* 记录详情弹窗 */
  $("recCloseBtn").onclick = closeRecord;
  $("recDeleteBtn").onclick = async () => {
    const id = HIST.openId;
    if (!id) return;
    const ok = await askConfirm("确定删除这条记录吗？此操作不可撤销。",
      { title: "删除这条记录", okText: "删除", danger: true });
    if (!ok) return;
    closeRecord();
    const removed = deleteHistoryIds([id]);
    refreshAll();
    toast(removed ? "已删除 1 条记录" : "记录不存在");
  };
  $("recordModal").onclick = (e) => { if (e.target === $("recordModal")) closeRecord(); };

  /* 通用确认弹窗 */
  $("confirmOkBtn").onclick = () => settleConfirm(true);
  $("confirmCancelBtn").onclick = () => settleConfirm(false);
  $("confirmModal").onclick = (e) => { if (e.target === $("confirmModal")) settleConfirm(false); };

  $("tomatoViewBtn").onclick = openTomato;
  $("tvPause").onclick = (e) => {
    e.stopPropagation();
    if (T.status === "running") pauseTimer();
    else if (T.status === "paused") resumeTimer();
    else startTimer();
  };
  // 全屏层统一接管：点到番茄图形 → 互动；点其它任何地方 → 关闭
  $("tomatoView").onclick = (e) => {
    if (e.target.closest("#tvPause")) return; // 暂停按钮自行处理
    // 精确匹配番茄实际图形（光晕层 pointer-events:none 不拦截，点它等于点身体）
    const onTomatoShape = e.target.closest(".tv-body, .tv-shine, .tv-leaf, .tv-leaf2, .tv-stem, .tv-glow, .tv-crown");
    if (onTomatoShape) { pokeTomato(e); return; }
    closeTomato();
  };
  // hover：番茄朝光标方向轻轻歪头（只在专注页面开启时生效）
  $("tomatoView").addEventListener("pointermove", (e) => {
    if (!tvOpen || tvClosing || JR_REDUCED) return;
    const svg = $("tvTomato").querySelector("svg");
    if (!svg) return;
    const r = $("tvTomato").getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = (e.clientX - cx) / (window.innerWidth / 2);
    const dy = (e.clientY - cy) / (window.innerHeight / 2);
    // 距离越远歪得越明显，上限 ±7°
    const tiltX = Math.max(-7, Math.min(7, dy * -6));
    const tiltY = Math.max(-7, Math.min(7, dx * 6));
    svg.style.transform = `perspective(600px) rotateX(${tiltX.toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg)`;
  });
  $("tomatoView").addEventListener("pointerleave", () => {
    const svg = $("tvTomato").querySelector("svg");
    if (svg) svg.style.transform = "";
  });

  $("addModeBtn").onclick = () => openModeModal(null);
  $("modeCancelBtn").onclick = closeModeModal;
  $("modeSaveBtn").onclick = saveMode;
  $("deleteModeBtn").onclick = deleteMode;
  $("modeModal").onclick = (e) => { if (e.target === $("modeModal")) closeModeModal(); };
  $("settingsModal").onclick = (e) => { if (e.target === $("settingsModal")) closeSettings(); };
  // 回车直接保存模式；输入框里回车也算（避免用户以为没反应）
  $("modeModal").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT")) { e.preventDefault(); saveMode(); }
    }
  });
  // 输入时立刻去掉红框，反馈更跟手
  ["modeFocusInput", "modeBreakInput", "modeNameInput"].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener("input", () => { el.classList.remove("field-error"); el.removeAttribute("aria-invalid"); });
  });

  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    // 确认弹窗优先级最高，先处理它的 Escape / Enter
    if (!$("confirmModal").classList.contains("hidden")) {
      if (e.key === "Escape") { e.preventDefault(); settleConfirm(false); }
      else if (e.key === "Enter") { e.preventDefault(); settleConfirm(true); }
      return;
    }
    if (!$("recordModal").classList.contains("hidden")) {
      if (e.key === "Escape") { e.preventDefault(); closeRecord(); return; }
    }
    // 等级页面是独立全屏页：Esc 返回，并屏蔽其余快捷键（R/S/I/F/T 会误触计时器）
    if (lvOpen) {
      if (e.key === "Escape") { e.preventDefault(); closeLevelPage(); }
      return;
    }
    if (tag === "input" || tag === "textarea") return;
    const modalOpen = !$("modeModal").classList.contains("hidden") || !$("settingsModal").classList.contains("hidden");
    if (e.key === "Escape") {
      if (!$("modeModal").classList.contains("hidden")) return closeModeModal();
      if (!$("settingsModal").classList.contains("hidden")) return closeSettings();
      if (tvOpen) return closeTomato();
    }
    if (modalOpen) return;
    const k = e.key.toLowerCase();
    if (e.code === "Space") {
      e.preventDefault();
      if (T.status === "running") pauseTimer();
      else if (T.status === "paused") resumeTimer();
      else startTimer();
    } else if (k === "r") resetTimer();
    else if (k === "s") skipPhase();
    else if (k === "i") interruptPhase();
    else if (k === "f") tvOpen ? closeTomato() : openTomato();
    else if (k === "t") toggleTheme();
  });
}

/* ---------- Rubber Segment 时间范围（motion 弹簧驱动） ---------- */
const RS = (() => {
  const EASE_OUT = [0.23, 1, 0.32, 1];
  const SPRING_UI = { type: "spring", duration: 0.3, bounce: 0 };
  const SPRING_MOMENTUM = { type: "spring", duration: 0.4, bounce: 0.2 };
  const SPRING_RELAX = { type: "spring", duration: 0.16, bounce: 0 };
  const DILATE = 0.19, HANDOFF = 0.15, FLICK = 110, MAXV = 2000;
  const DEADZONE = 4, SLOP = 10, RUBBER = 0.55;
  const STRETCH = 100, GLIDE = 75, SQUASH = 3, INSET = 3, TR = 9;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rub = (o, d) => (o * d * RUBBER) / (d + RUBBER * Math.abs(o));
  const proj = (v, g) => { const d = 1 - 0.1 * Math.pow(0.05, g / 100); return (v / 1000) * d / (1 - d); };

  let track, thumb, items = [], slots = [], box = null;
  let innerW = 0, committed = 0, handoff = 0, drag = null, gen = 0, cb = null;
  let edgeL = null, edgeR = null;

  // MotionValue；motion 未加载时降级为瞬时切换
  const mv = (v0) => {
    if (JR_MOTION) return new JR_MOTION.MotionValue(v0);
    const o = {
      v: v0, cbs: [],
      get() { return this.v; },
      set(x) { this.v = x; this.cbs.forEach((f) => f(x)); },
      jump(x) { this.set(x); },
      stop() {}, getVelocity: () => 0,
      on(e, f) { this.cbs.push(f); },
    };
    return o;
  };
  const anim = (m, to, opts) => {
    if (JR_MOTION && !JR_REDUCED) JR_MOTION.animate(m, to, opts);
    else m.jump(to);
  };

  const paint = () => {
    if (!thumb) return;
    thumb.style.clipPath =
      `inset(0 ${Math.max(0, innerW - edgeR.get())}px 0 ${Math.max(0, edgeL.get())}px round ${TR}px)`;
  };

  const vel = (h, now) => {
    const r = h.filter(([t]) => now - t <= 100);
    if (r.length < 2) return 0;
    const [t0, x0] = r[0], [t1, x1] = r[r.length - 1];
    return t1 - t0 >= 8 ? ((x1 - x0) / (t1 - t0)) * 1000 : 0;
  };
  const nearest = (x) => {
    let b = 0;
    for (let i = 1; i < slots.length; i++) {
      if (Math.abs((slots[i].l + slots[i].r) / 2 - x) < Math.abs((slots[b].l + slots[b].r) / 2 - x)) b = i;
    }
    return b;
  };

  const jumpTo = (i) => {
    const s = slots[i];
    if (!s) return;
    clearTimeout(handoff); gen++;
    edgeL.jump(s.l); edgeR.jump(s.r);
  };
  const measure = () => {
    if (!track || !items.length) return;
    const r = track.getBoundingClientRect();
    box = r;
    slots = items.map((el) => {
      const b = el.getBoundingClientRect();
      return { l: b.left - r.left - INSET, r: b.right - r.left - INSET };
    });
    innerW = Math.max(0, r.width - INSET * 2);
    jumpTo(committed);
  };
  const commit = (i) => {
    committed = i;
    items.forEach((el, k) => {
      el.setAttribute("aria-checked", k === i ? "true" : "false");
      el.tabIndex = k === i ? 0 : -1;
    });
    if (cb) cb(items[i].dataset.range, i);
  };
  const land = (to, v, flick, sq) => {
    const b = slots[to];
    if (!b) return;
    const g = ++gen;
    const dir = Math.sign((b.l + b.r) / 2 - (edgeL.get() + edgeR.get()) / 2) || 1;
    const [lead, lt, trail, tt] = dir > 0 ? [edgeR, b.r, edgeL, b.l] : [edgeL, b.l, edgeR, b.r];
    const cv = (m) => clamp(v == null ? m.getVelocity() : v, -MAXV, MAXV);
    anim(lead, lt, { ...(flick ? SPRING_MOMENTUM : SPRING_UI), velocity: cv(lead) });
    if (!sq || SQUASH <= 0) { anim(trail, tt, { ...SPRING_UI, velocity: cv(trail) }); return; }
    anim(trail, tt + dir * SQUASH, { ...SPRING_UI, velocity: cv(trail) });
    setTimeout(() => { if (gen === g) anim(trail, tt, SPRING_RELAX); }, 300);
  };
  const travel = (from, to) => {
    const a = slots[from], b = slots[to];
    if (!a || !b) return;
    clearTimeout(handoff); gen++;
    if (JR_REDUCED || !JR_MOTION) { edgeL.jump(b.l); edgeR.jump(b.r); return; }
    const u = STRETCH / 100;
    const tween = { duration: DILATE, ease: EASE_OUT };
    anim(edgeL, b.l + (Math.min(a.l, b.l) - b.l) * u, tween);
    anim(edgeR, b.r + (Math.max(a.r, b.r) - b.r) * u, tween);
    handoff = setTimeout(() => land(to, null, false, true), HANDOFF * 1000);
  };

  const localX = (e) => e.clientX - box.left - INSET;
  const down = (e, i) => {
    if (drag || e.button !== 0) return;
    box = track.getBoundingClientRect();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    const x = localX(e);
    const onThumb = x >= edgeL.get() && x <= edgeR.get();
    drag = { id: e.pointerId, x0: x, slot: i, onThumb, live: false, offset: 0, w: 0, hist: [[e.timeStamp, x]] };
    if (onThumb) { clearTimeout(handoff); gen++; edgeL.stop(); edgeR.stop(); }
    else if (!JR_REDUCED) e.currentTarget.dataset.pressed = "";
  };
  const move = (e) => {
    const d = drag;
    if (!d || e.pointerId !== d.id || !d.onThumb) return;
    const x = localX(e);
    d.hist.push([e.timeStamp, x]);
    if (d.hist.length > 8) d.hist.shift();
    if (!d.live) {
      if (Math.abs(x - d.x0) < DEADZONE) return;
      d.live = true;
      d.offset = x - edgeL.get();
      d.w = edgeR.get() - edgeL.get();
      track.dataset.held = "";
    }
    const maxL = innerW - d.w, l = x - d.offset;
    if (JR_REDUCED) { const c = clamp(l, 0, maxL); edgeL.set(c); edgeR.set(c + d.w); }
    else if (l < 0) { edgeL.set(0); edgeR.set(d.w - rub(-l, d.w)); }
    else if (l > maxL) { edgeR.set(innerW); edgeL.set(maxL + rub(l - maxL, d.w)); }
    else { edgeL.set(l); edgeR.set(l + d.w); }
  };
  const release = () => {
    const d = drag;
    drag = null;
    delete track.dataset.held;
    if (d) { const el = items[d.slot]; if (el) delete el.dataset.pressed; }
    return d;
  };
  const up = (e) => {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    release();
    const x = localX(e);
    if (!d.live) {
      if (Math.abs(x - d.x0) <= SLOP && d.slot !== committed) {
        const from = committed;
        commit(d.slot);
        travel(from, d.slot);
      }
      return;
    }
    const v = vel(d.hist, e.timeStamp);
    const flick = Math.abs(v) > FLICK;
    let to = nearest((edgeL.get() + edgeR.get()) / 2 + proj(v, GLIDE));
    if (flick && to === committed) to = clamp(to + Math.sign(v), 0, items.length - 1);
    commit(to);
    if (JR_REDUCED || !JR_MOTION) jumpTo(to);
    else land(to, v, flick, flick);
  };
  const cancel = (e) => {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    release();
    if (!d.live) return;
    if (JR_REDUCED || !JR_MOTION) jumpTo(committed);
    else land(committed, null, false, false);
  };
  const key = (e, i) => {
    const last = items.length - 1;
    let n = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") n = Math.min(last, i + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") n = Math.max(0, i - 1);
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = last;
    if (n === null) return;
    e.preventDefault();
    if (n === committed) return;
    commit(n);
    jumpTo(n);
    items[n].focus();
  };

  function init(onChange) {
    track = $("rangeTabs");
    thumb = track.querySelector(".rubber-segment__thumb");
    items = Array.from(track.querySelectorAll(":scope > .rubber-segment__item"));
    cb = onChange;
    edgeL = mv(0);
    edgeR = mv(0);
    edgeL.on("change", paint);
    edgeR.on("change", paint);
    items.forEach((el, i) => {
      el.addEventListener("pointerdown", (e) => down(e, i));
      el.addEventListener("keydown", (e) => key(e, i));
      // 键盘 Enter/Space 激活（e.detail === 0 表示非鼠标点击）
      el.addEventListener("click", (e) => {
        if (e.detail !== 0 || i === committed) return;
        const from = committed;
        commit(i);
        travel(from, i);
      });
    });
    track.addEventListener("pointermove", move);
    track.addEventListener("pointerup", up);
    track.addEventListener("pointercancel", cancel);
    track.addEventListener("lostpointercapture", cancel);
    measure();
    let rafId = 0;
    const schedule = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => { rafId = 0; measure(); });
    };
    if (typeof ResizeObserver !== "undefined") {
      // 观察控件与父容器：双栏/单栏切换、窗口缩放都能触发重算
      const ro = new ResizeObserver(schedule);
      ro.observe(track);
      if (track.parentElement) ro.observe(track.parentElement);
    }
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", () => setTimeout(measure, 120));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => measure());
  }

  return { init };
})();

/* ---------- 启动 ---------- */
applyTheme(store.settings.theme);
T.remaining = phaseTotal();
bind();
SYNC.bindUI();
markVisit();       // 记录本次访问（独立 key，不触发 save，避免污染同步时间戳）
refreshAll();
RS.init((v) => { curRange = v; renderRange(); });
KPapi.init();
if (SYNC.on()) SYNC.pull(true); // 已开启同步 → 启动静默拉取云端

/* 尺寸变化（窗口缩放/字体加载/换行）后重新测量果冻按钮，保持挤开距离正确 */
(function jrWatchSize() {
  let rafId = 0;
  const relayout = () => {
    if (!jrChips.length || jrLastSel < 0) return;
    jrMeasure();
    jrApply(jrLastSel, true);
  };
  const schedule = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; relayout(); });
  };
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(schedule);
    ro.observe($("modeChips"));
    const bar = document.querySelector(".mode-bar");
    if (bar) ro.observe(bar); // 容器换行导致高度变化时也重测
  }
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", () => setTimeout(relayout, 120));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
})();
