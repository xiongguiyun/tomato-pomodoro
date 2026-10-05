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

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (raw && Array.isArray(raw.modes) && raw.modes.length) {
      return {
        modes: raw.modes,
        activeModeId: raw.activeModeId || raw.modes[0].id,
        settings: Object.assign({ theme: "light", sound: true, autoBreak: false, autoFocus: false, wake: false, dailyGoal: 8 }, raw.settings || {}),
        sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
        interrupts: Array.isArray(raw.interrupts) ? raw.interrupts : [],
        goalDay: raw.goalDay || "",
      };
    }
  } catch (e) { /* 数据损坏则重建 */ }
  return { modes: DEFAULT_MODES.map((m) => ({ ...m })), activeModeId: "m-default",
    settings: { theme: "light", sound: true, autoBreak: false, autoFocus: false, wake: false, dailyGoal: 8 },
    sessions: [], interrupts: [], goalDay: "" };
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
    store.sessions.push({ ts: Date.now(), m: activeMode().name, status: "stopped", sec: Math.round(focused / 1000) });
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
    store.sessions.push({ ts: Date.now(), m: activeMode().name, status: "stopped", sec: Math.round(focused / 1000) });
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
    store.sessions.push({ ts: Date.now(), m: activeMode().name, status: "interrupted", sec: Math.round(focused / 1000) });
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
    store.sessions.push({ ts: Date.now(), m: m.name, status: "completed", sec: m.focus * 60 });
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
const LEVEL_NAMES = ["种子", "发芽", "幼苗", "青苗", "番茄苗", "结果", "满园", "番茄新手", "番茄熟手",
  "番茄达人", "专注学徒", "专注好手", "深度行者", "心流旅人", "心流大师", "效率专家", "传奇园丁", "不朽传说"];
function xp() { return Math.round(totalMinutes()) + completedSessions().length * 5; }
function levelOf(x) {
  let lv = 1;
  while (lv < 99 && x >= xpNeeded(lv + 1)) lv++;
  return lv;
}
function xpNeeded(lv) { return lv <= 1 ? 0 : Math.round(60 * Math.pow(lv - 1, 1.5)); }
function levelName(lv) { return LEVEL_NAMES[lv - 1] || `达人 Lv.${lv}`; }

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
  jrWidths = jrChips.map((c) => c.el.offsetWidth);
  const chipH = jrChips[0].el.offsetHeight || 36;
  const maxW = Math.max(0, ...jrWidths);
  const C = JR_CFG;
  group.style.setProperty("--jr-pad-x", `${Math.ceil((maxW * C.swell * 1.3) / 2 + C.barge) + 2}px`);
  group.style.setProperty("--jr-pad-y", `${Math.ceil((chipH * C.swell) / 2) + 2}px`);
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
  const sig = store.modes.map((m) => `${m.id}:${m.name}:${m.focus}:${m.brk}:${m.color}:${m.custom}`).join("|");
  const selIdx = Math.max(0, store.modes.findIndex((m) => m.id === store.activeModeId));
  let rebuilt = false;
  if (sig !== jrSig) {
    jrSig = sig;
    wrap.innerHTML = "";
    jrChips = store.modes.map((m) => { const c = jrCreateChip(m); wrap.appendChild(c.el); return c; });
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
  const cur = xpNeeded(lv), next = xpNeeded(lv + 1);
  const pct = next > cur ? Math.min(100, ((x - cur) / (next - cur)) * 100) : 100;
  $("levelBadge").textContent = lv;
  $("levelName").textContent = `Lv.${lv} ${levelName(lv)}`;
  $("levelXp").textContent = `${x} / ${next} XP`;
  $("levelNext").textContent = `下一级：${levelName(lv + 1)}`;
  $("levelFill").style.width = pct + "%";
  $("brandLevel").textContent = `Lv.${lv} ${levelName(lv)}`;
}

/* 升级任务面板（默认折叠，只渲染数据，展开状态由用户控制） */
function renderTasks() {
  const panel = $("taskPanel");
  if (panel.classList.contains("hidden")) return; // 折叠时不刷新，展开时立即更新
  const x = xp(), lv = levelOf(x);
  const cur = xpNeeded(lv), next = xpNeeded(lv + 1);
  const goal = store.settings.dailyGoal || 8;
  const today = countToday();
  const st = streak();
  // 下一个打卡里程碑
  const milestones = [3, 7, 14, 21, 30, 60, 100, 365];
  const milestone = milestones.find((m) => m > st) || Math.ceil((st + 1) / 100) * 100;

  const tasks = [
    { icon: "⚡", title: `积累到 ${next} XP（升到 Lv.${lv + 1}）`,
      hint: `还差 ${Math.max(0, next - x)} XP，约 ${Math.max(1, Math.ceil((next - x) / 30))} 个番茄`,
      pct: next > cur ? Math.min(100, ((x - cur) / (next - cur)) * 100) : 100,
      val: `${x}/${next}` },
    { icon: "🍅", title: `今日完成 ${goal} 个番茄`,
      hint: `今日目标 ${goal} 个，完成后可保持打卡`,
      pct: Math.min(100, (today / goal) * 100),
      val: `${today}/${goal}` },
    { icon: "🔥", title: `连续打卡达到 ${milestone} 天`,
      hint: `当前连续 ${st} 天`,
      pct: Math.min(100, (st / milestone) * 100),
      val: `${st}/${milestone}` },
  ];

  panel.innerHTML = tasks.map((t) => `
    <div class="task-row${t.pct >= 100 ? " done" : ""}">
      <span class="task-icon">${t.pct >= 100 ? "✅" : t.icon}</span>
      <div class="task-body">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-hint">${esc(t.hint)}</div>
        <div class="task-bar"><div class="task-bar-fill" style="width:${t.pct}%"></div></div>
      </div>
      <span class="task-pct">${t.pct >= 100 ? "完成" : Math.floor(t.pct) + "%"}</span>
    </div>`).join("");
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

function renderHistory() {
  const box = $("history");
  const list = store.sessions.slice(-14).reverse();
  if (!list.length) {
    box.innerHTML = '<div class="history-empty">还没有记录，完成一次专注后这里会出现历史 🍅</div>';
    return;
  }
  const now = Date.now();
  box.innerHTML = list.map((s) => {
    const d = new Date(s.ts);
    const day = s.ts >= startOfDay(now) ? "今天" : s.ts >= startOfDay(now) - 86400000 ? "昨天" : `${d.getMonth() + 1}-${pad(d.getDate())}`;
    const tag = s.status === "completed" ? '<span class="h-tag ok">完成</span>'
      : s.status === "interrupted" ? '<span class="h-tag bad">打断</span>'
      : '<span class="h-tag bad">停止</span>';
    return `<div class="h-row"><span class="h-dot"></span><span class="h-main">${esc(s.m)} · ${fmtDur(s.sec / 60)}</span>${tag}<span class="h-time">${day} ${pad(d.getHours())}:${pad(d.getMinutes())}</span></div>`;
  }).join("");
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
const KP = { h: 0, s: 100, l: 50, a: 100, open: false, dragging: null, outside: null };

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

    const track = (el, fn) => {
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        KP.dragging = el;
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
        fn(e);
      });
      el.addEventListener("pointermove", (e) => { if (KP.dragging === el) fn(e); });
      el.addEventListener("pointerup", () => { KP.dragging = null; });
      el.addEventListener("pointercancel", () => { KP.dragging = null; });
    };
    const pos = (e, el) => {
      const r = el.getBoundingClientRect();
      return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
              Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
    };

    // 饱和度 / 亮度方块（kibo: saturation = x*100, lightness = topL*(1-y)）
    track(sel, (e) => {
      const [x, y] = pos(e, sel);
      KP.s = x * 100;
      const topL = x < 0.01 ? 100 : 50 + 50 * (1 - x);
      KP.l = topL * (1 - y);
      this.sync();
    });
    // 色相条
    track(hue, (e) => { KP.h = pos(e, hue)[0] * 360; this.sync(); });
    // 透明度条（横向）
    track(alpha, (e) => { KP.a = pos(e, alpha)[0] * 100; this.sync(); });

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
      // 定位：浮层锚定在色点下方，箭头指向色点；贴边时自动内收
      const r = dot.getBoundingClientRect();
      const pw = Math.min(300, window.innerWidth - 24);
      let left = r.left + r.width / 2 - pw / 2;
      left = Math.max(12, Math.min(left, window.innerWidth - pw - 12));
      const arrowX = Math.max(16, Math.min(r.left + r.width / 2 - left - 7, pw - 30));
      panel.style.left = `${left}px`;
      panel.style.setProperty("--kp-arrow-x", `${arrowX}px`);
      // 色点下方放不下时翻转到上方
      const ph = panel.offsetHeight;
      if (r.bottom + 10 + ph > window.innerHeight && r.top > ph + 10) {
        panel.style.top = `${r.top - ph - 10}px`;
        panel.dataset.arrow = "bottom";
      } else {
        panel.style.top = `${r.bottom + 10}px`;
        panel.dataset.arrow = "top";
      }
      this.setColor(pickedColor);
      this.sync();
      // 点击外部自动收起（延迟绑定，避免点色点本身误关）
      setTimeout(() => {
        KP.outside = (e) => {
          if (!panel.contains(e.target) && !(dot && dot.contains(e.target))) {
            KPapi.close();
          }
        };
        document.addEventListener("pointerdown", KP.outside, true);
      }, 0);
    } else if (KP.outside) {
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

function saveMode() {
  const name = ($("modeNameInput").value || "").trim().slice(0, 8);
  const focus = Math.min(180, Math.max(1, parseInt($("modeFocusInput").value, 10) || 25));
  const brk = Math.min(60, Math.max(1, parseInt($("modeBreakInput").value, 10) || 5));
  if (!name) { toast("请输入模式名称"); return; }
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

/* ---------- 设置弹窗 ---------- */
function openSettings() {
  const s = store.settings;
  $("setSound").checked = s.sound;
  $("setAutoBreak").checked = s.autoBreak;
  $("setAutoFocus").checked = s.autoFocus;
  $("setWake").checked = s.wake;
  $("setGoal").value = s.dailyGoal || 8;
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
    sessions: [], interrupts: [], goalDay: "", updatedAt: 0,
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
    const open = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !open);
    btn.setAttribute("aria-expanded", String(open));
    if (open) renderTasks();
  };

  $("themeBtn").onclick = toggleTheme;
  $("statsJumpBtn").onclick = () => $("statsSection").scrollIntoView({ behavior: "smooth", block: "start" });
  $("settingsBtn").onclick = openSettings;
  $("settingsCloseBtn").onclick = closeSettings;
  $("setSound").onchange = (e) => { store.settings.sound = e.target.checked; save(); if (e.target.checked) beep(false); };
  $("setAutoBreak").onchange = (e) => { store.settings.autoBreak = e.target.checked; save(); };
  $("setAutoFocus").onchange = (e) => { store.settings.autoFocus = e.target.checked; save(); };
  $("setWake").onchange = (e) => { store.settings.wake = e.target.checked; save(); if (!e.target.checked) releaseWake(); else if (T.status === "running") requestWake(); };
  $("exportBtn").onclick = () => {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tomato-data-${dayKey(Date.now())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  };
  $("clearBtn").onclick = () => {
    if (!confirm("确定清空所有专注记录与中断记录吗？模式与设置会保留。")) return;
    store.sessions = []; store.interrupts = []; store.goalDay = "";
    save(); refreshAll(); toast("记录已清空");
  };

  $("tomatoViewBtn").onclick = openTomato;
  $("tvPause").onclick = (e) => {
    e.stopPropagation();
    if (T.status === "running") pauseTimer();
    else if (T.status === "paused") resumeTimer();
    else startTimer();
  };
  $("tvInner").onclick = (e) => { if (e.target === $("tvInner") || e.target.closest(".tv-tomato, .tv-time, .tv-phase, .tv-hint")) closeTomato(); };

  $("addModeBtn").onclick = () => openModeModal(null);
  $("modeCancelBtn").onclick = closeModeModal;
  $("modeSaveBtn").onclick = saveMode;
  $("deleteModeBtn").onclick = deleteMode;
  $("modeModal").onclick = (e) => { if (e.target === $("modeModal")) closeModeModal(); };
  $("settingsModal").onclick = (e) => { if (e.target === $("settingsModal")) closeSettings(); };

  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
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
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => measure()).observe(track);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => measure());
  }

  return { init };
})();

/* ---------- 启动 ---------- */
applyTheme(store.settings.theme);
T.remaining = phaseTotal();
bind();
SYNC.bindUI();
refreshAll();
RS.init((v) => { curRange = v; renderRange(); });
KPapi.init();
if (SYNC.on()) SYNC.pull(true); // 已开启同步 → 启动静默拉取云端

/* 尺寸变化（窗口缩放/字体加载）后重新测量果冻按钮，保持挤开距离正确 */
(function jrWatchSize() {
  const relayout = () => {
    if (!jrChips.length || jrLastSel < 0) return;
    jrMeasure();
    jrApply(jrLastSel, true);
  };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(relayout).observe($("modeChips"));
  window.addEventListener("resize", relayout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);
})();
