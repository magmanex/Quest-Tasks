// popup.js
import { parseQuickAdd, bangkokToday, addDays } from "../lib/thaiDate.js";
import { levelFromXp, rankLetter } from "../lib/storage.js";

const $ = (id) => document.getElementById(id);

// minimal SVG icon set (stroke=currentColor) ใช้แทน emoji ใน empty/error state
const svg = (paths) =>
  `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor"
        stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const ICONS = {
  clear: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9"/>'),
  inbox: svg('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
  warn: svg('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
};

// ทุก action คุยกับ Notion ผ่าน background -> โชว์ syncbar ตลอดที่ยังมี request ค้าง
let pending = 0;
const send = (msg) => {
  pending++;
  $("syncbar").classList.add("on");
  return chrome.runtime.sendMessage(msg).finally(() => {
    if (--pending <= 0) { pending = 0; $("syncbar").classList.remove("on"); }
  });
};

const rankClass = (rank) => "rank-" + rankLetter(rank);

function fmtDate(iso, today) {
  if (!iso) return "";
  const day = iso.slice(0, 10);
  const time = iso.length > 10 ? " " + iso.slice(11, 16) : ""; // "...T12:00..." -> " 12:00"
  if (day === today) return "วันนี้" + time;
  const [y, m, d] = day.split("-").map(Number);
  return `${d}/${m}${time}`;
}

// จำนวนวันจาก today ถึง iso (อิงปฏิทิน, ไม่สน timezone offset ภายในวัน)
function daysAhead(today, iso) {
  const [ay, am, ad] = today.split("-").map(Number);
  const [by, bm, bd] = iso.slice(0, 10).split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

function dayLabel(iso, today) {
  const d = daysAhead(today, iso);
  if (d === 1) return "พรุ่งนี้";
  if (d === 2) return "มะรืน";
  return `อีก ${d} วัน`;
}

function renderGame(game) {
  const { level, intoLevel, needForNext } = levelFromXp(game.xp);
  $("lvl-num").textContent = level;
  $("xp-fill").style.width = `${Math.min(100, (intoLevel / needForNext) * 100)}%`;
  $("xp-text").textContent = `${intoLevel} / ${needForNext} XP`;
  $("streak-num").textContent = game.streak;
}

// --- ลำดับ task ภายในวัน: เก็บ local เท่านั้น (chrome.storage) ไม่ยุ่ง Notion ---
// orderIds = ลิสต์ id เรียงตามลำดับที่ผู้ใช้จัด; id ที่ไม่อยู่ในนี้เรียงตามวันเตือน (ต่อท้าย)
let orderIds = [];
let lastDue = [], lastUpcoming = [], lastToday = bangkokToday();

async function loadOrder() {
  orderIds = (await chrome.storage.local.get("taskOrder")).taskOrder || [];
}
function sortByOrder(tasks) {
  const idx = (id) => { const i = orderIds.indexOf(id); return i === -1 ? Infinity : i; };
  // tiebreak สำหรับ id ที่ผู้ใช้ยังไม่จัดลำดับเอง: เรียงตามวัน → มีเวลาก่อน → เวลาน้อยไปมาก
  // งานไม่ระบุเวลา (date-only) ต่อท้ายงานที่มีเวลาในวันเดียวกัน
  const key = (t) => {
    const d = t.date || "9999-12-31";          // ไม่มีวัน → ท้ายสุด
    const timed = d.length > 10;
    return { day: d.slice(0, 10), timed, time: timed ? d.slice(10) : "" };
  };
  return [...tasks].sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka.timed !== kb.timed) return ka.timed ? -1 : 1;  // มีเวลามาก่อนเสมอ (เหนือลำดับ drag)
    const di = idx(a.id) - idx(b.id);
    if (di !== 0 && (idx(a.id) !== Infinity || idx(b.id) !== Infinity)) return di; // ลำดับ drag ภายในกลุ่ม
    if (ka.day !== kb.day) return ka.day < kb.day ? -1 : 1;
    return ka.time < kb.time ? -1 : ka.time > kb.time ? 1 : 0;
  });
}
// จัดลำดับใหม่จากลำดับจริงใน DOM ของ container (วันเดียวกัน) แล้วเอา dragId ไปวางก่อน targetId
// อ่านจาก DOM ทำให้ item ที่ไม่ได้แตะคงตำแหน่งเดิม (ไม่ลอยขึ้นบน)
function reorderInContainer(container, dragId, targetId) {
  const sib = [...container.children].map((c) => c.dataset.id).filter(Boolean);
  const di = sib.indexOf(dragId);
  if (di !== -1) sib.splice(di, 1);
  const ti = sib.indexOf(targetId);
  sib.splice(ti === -1 ? sib.length : ti, 0, dragId);
  orderIds = [...sib, ...orderIds.filter((x) => !sib.includes(x))];
  chrome.storage.local.set({ taskOrder: orderIds });
}
function rerender() {
  renderList(lastDue, lastToday);
  renderUpcoming(lastUpcoming, lastToday);
}

// --- drag & drop: ลาก task ข้ามวันเพื่อเปลี่ยนวันเตือน (อัปเดต Notion) ---
// เก็บเวลาเดิม (ถ้ามี) ไว้ ย้ายแค่วัน เช่นลากงาน 12.00 พรุ่งนี้มาวันนี้ ก็ยังเป็น 12.00
function makeDraggable(el, task) {
  el.draggable = true;
  el.dataset.id = task.id; // ใช้อ่านลำดับจริงตอนจัดลำดับใหม่
  el.addEventListener("dragstart", (e) => {
    if (e.target.closest("input")) { e.preventDefault(); return; } // แก้วันใน input ไม่ใช่การลาก
    e.dataTransfer.setData("text/id", task.id);
    e.dataTransfer.setData("text/date", task.date || "");
    e.dataTransfer.effectAllowed = "move";
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => el.classList.remove("dragging"));
}

// drop ลงบน task อีกอันโดยตรง: วันเดียวกัน = จัดลำดับ (local), คนละวัน = ย้ายวัน (Notion)
function makeReorderTarget(el, task) {
  el.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); el.classList.add("drag-over"); });
  el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation(); // กัน drop zone ของวันซ้อนทำงานซ้ำ
    el.classList.remove("drag-over");
    const id = e.dataTransfer.getData("text/id");
    const from = e.dataTransfer.getData("text/date");
    const targetDay = (task.date || "").slice(0, 10);
    if (!id || id === task.id) return;
    if (from.slice(0, 10) === targetDay) {
      reorderInContainer(el.parentElement, id, task.id); // จัดลำดับภายในวัน
      rerender();
    } else {
      const time = from.length > 10 ? from.slice(10) : "";
      await send({ action: "setDate", pageId: id, dateISO: targetDay + time });
      load();
    }
  });
}

// targetDay: ISO วัน หรือ null = "วันนี้" (คำนวณตอน drop)
function makeDropZone(el, targetDay) {
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drag-over"); });
  el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    el.classList.remove("drag-over");
    const id = e.dataTransfer.getData("text/id");
    const from = e.dataTransfer.getData("text/date");
    if (!id) return;
    const day = targetDay || bangkokToday();
    if (from.slice(0, 10) === day) return; // วันเดิม — ไม่มีลำดับให้จัด ข้าม
    const time = from.length > 10 ? from.slice(10) : ""; // "T12:00:00+07:00"
    await send({ action: "setDate", pageId: id, dateISO: day + time });
    load();
  });
}

function renderList(tasks, today) {
  const list = $("list");
  list.innerHTML = "";
  if (tasks.length === 0) {
    list.innerHTML = `<div class="empty">
      <span class="empty-mark">${ICONS.clear}</span>
      <div>เคลียร์ครบแล้ว</div>
      <div class="empty-sub">ไม่มี quest ค้างวันนี้</div>
    </div>`;
    return;
  }
  for (const t of sortByOrder(tasks)) {
    const overdue = t.date && t.date < today;
    const card = document.createElement("div");
    card.className = "card" + (overdue ? " overdue" : "");
    card.innerHTML = `
      <div class="card-top">
        <span class="rank ${rankClass(t.rank)}">${rankLetter(t.rank)}</span>
        <span class="card-title"></span>
        <span class="card-date ${overdue ? "late" : ""}">${overdue ? "เลยมา " : ""}${fmtDate(t.date, today)}</span>
      </div>
      <div class="card-actions">
        <button class="act act-done">✓ เคลียร์</button>
        <button class="act act-snooze" title="เลื่อนไปพรุ่งนี้">เลื่อนไปพรุ่งนี้</button>
        <button class="act act-open" title="แก้ไข/ลบใน Notion" ${t.url ? "" : "hidden"}>↗ Notion</button>
      </div>`;
    card.querySelector(".card-title").textContent = t.title;
    card.querySelector(".act-done").addEventListener("click", () => complete(card, t));
    card.querySelector(".act-snooze").addEventListener("click", () => snooze(card, t));
    if (t.url) card.querySelector(".act-open").addEventListener("click", () => chrome.tabs.create({ url: t.url }));
    makeDraggable(card, t);
    makeReorderTarget(card, t);
    list.appendChild(card);
  }
}

const expandedDays = new Set(); // จำว่าวันไหนกางอยู่ (ภายใน session popup)

function makeUpcomingRow(t) {
  const row = document.createElement("div");
  row.className = "up-item";
  row.innerHTML = `<span class="rank ${rankClass(t.rank)}">${rankLetter(t.rank)}</span><span class="up-item-title"></span><input type="date" class="up-date" title="เปลี่ยนวัน">`;
  row.querySelector(".up-item-title").textContent = t.title;
  const dateInput = row.querySelector(".up-date");
  dateInput.value = t.date.slice(0, 10);
  dateInput.addEventListener("change", async () => {
    const newDay = dateInput.value;
    if (!newDay || newDay === t.date.slice(0, 10)) return;
    const time = t.date.length > 10 ? t.date.slice(10) : ""; // คงเวลาเดิมไว้
    await send({ action: "setDate", pageId: t.id, dateISO: newDay + time });
    load();
  });
  makeDraggable(row, t);
  makeReorderTarget(row, t);
  return row;
}

// แสดง 3 วันถัดไป (พรุ่งนี้ + อีก 2 วัน) แต่ละวัน collapse ได้เอง พร้อมเลขนับ task
function renderUpcoming(tasks, today) {
  const section = $("upcoming");
  const body = $("up-body");
  body.innerHTML = "";
  section.hidden = false;

  const byDay = new Map();
  for (const t of (tasks || [])) {
    const d = t.date.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(t);
  }

  for (let n = 1; n <= 3; n++) {
    const day = addDays(today, n);
    const items = sortByOrder(byDay.get(day) || []);
    const open = expandedDays.has(day);

    const block = document.createElement("div");
    block.className = "up-group";

    const toggle = document.createElement("button");
    toggle.className = "up-toggle";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.innerHTML = `<span class="up-caret">▸</span>
      <span class="up-day-name"></span>
      <span class="up-day-date"></span>
      <span class="up-count">${items.length}</span>`;
    toggle.querySelector(".up-day-name").textContent = dayLabel(day, today);
    toggle.querySelector(".up-day-date").textContent = fmtDate(day, today);

    const dayBody = document.createElement("div");
    dayBody.className = "up-body-day";
    dayBody.hidden = !open;
    makeDropZone(dayBody, day); // ลาก task มาลงวันนี้ได้
    if (items.length === 0) {
      dayBody.innerHTML = `<div class="up-empty">ไม่มีงาน</div>`;
    } else {
      for (const t of items) dayBody.appendChild(makeUpcomingRow(t));
    }

    toggle.addEventListener("click", () => {
      const nowOpen = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(nowOpen));
      dayBody.hidden = !nowOpen;
      if (nowOpen) expandedDays.add(day); else expandedDays.delete(day);
    });

    block.appendChild(toggle);
    block.appendChild(dayBody);
    body.appendChild(block);
  }
}

async function complete(card, task) {
  card.classList.add("clearing");
  const res = await send({ action: "complete", pageId: task.id, rank: task.rank });
  setTimeout(() => load(), 320);
  if (res?.ok && res.reward) {
    flashHint(`+${res.reward.gained} XP${res.reward.leveledUp ? " · เลเวลอัป! 🎉" : ""}`);
    if (res.game) renderGame(res.game);
  }
}

async function snooze(card, task) {
  card.classList.add("clearing");
  await send({ action: "snooze", pageId: task.id, days: 1 });
  setTimeout(() => load(), 320);
}

function flashHint(text) {
  const h = $("quick-hint");
  h.textContent = text;
  setTimeout(() => { if (h.textContent === text) h.textContent = ""; }, 2500);
}

async function quickAdd() {
  const raw = $("quick-input").value.trim();
  if (!raw) return;
  const { title, dateISO } = parseQuickAdd(raw);
  $("quick-input").value = "";
  flashHint(`เพิ่ม "${title}" → ${dateISO}`);
  const res = await send({ action: "add", title, dateISO, rank: "B - ปกติ" });
  if (!res?.ok) flashHint(`ผิดพลาด: ${res?.error || "ไม่ทราบสาเหตุ"}`);
  load();
}

async function load() {
  const today = bangkokToday();
  $("today-label").textContent = today;
  const status = await send({ action: "status" });

  if (!status?.setup) {
    $("list").innerHTML = `
      <div class="setup-card">
        <h2>ยังไม่ได้เชื่อม Notion</h2>
        <p>ตั้งค่าครั้งแรกเพื่อสร้าง database และเริ่มใช้งาน</p>
        <button class="setup-btn" id="goto-setup">เปิดหน้าตั้งค่า</button>
      </div>`;
    $("goto-setup").addEventListener("click", () => chrome.runtime.openOptionsPage());
    $("quick-row").style.display = "none";
    $("upcoming").hidden = true;
    return;
  }

  if (status.game) renderGame(status.game);
  const res = await send({ action: "queryDue" });
  if (res?.ok) {
    lastToday = today;
    lastDue = res.tasks;
    renderList(res.tasks, today);
    if (res.game) renderGame(res.game);
    const up = await send({ action: "queryUpcoming", days: 3 });
    lastUpcoming = up?.ok ? up.tasks : [];
    renderUpcoming(lastUpcoming, today);
  } else {
    $("upcoming").hidden = true;
    $("list").innerHTML =
      `<div class="empty"><span class="empty-mark">${ICONS.warn}</span><div>ดึงข้อมูลไม่ได้</div>
       <div class="empty-sub">${res?.error || ""}</div></div>`;
  }
}

// ---------- อ่านทีหลัง ----------

let readingLoaded = false;

function fmtCreated(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("th-TH", { day: "numeric", month: "short" });
}

function renderReadingList(items) {
  const list = $("reading-list");
  list.innerHTML = "";
  if (items.length === 0) {
    list.innerHTML = `<div class="empty">
      <span class="empty-mark">${ICONS.inbox}</span>
      <div>ยังไม่มีอะไรค้างอ่าน</div>
      <div class="empty-sub">คลิกขวาตรงข้อความหรือลิงก์ → "เก็บไว้อ่านทีหลัง"</div>
    </div>`;
    return;
  }
  for (const item of items) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-top">
        <span class="card-title"></span>
        <span class="card-date">${fmtCreated(item.createdTime)}</span>
      </div>
      <div class="card-tags"></div>
      <div class="card-actions">
        <button class="act act-done">✓ อ่านแล้ว</button>
        <button class="act act-open" ${item.url ? "" : "hidden"}>↗ เปิดลิงก์</button>
        <button class="act act-archive">ลบ</button>
      </div>`;
    card.querySelector(".card-title").textContent = item.title;
    const tagsEl = card.querySelector(".card-tags");
    for (const tag of item.tags) {
      const chip = document.createElement("span");
      chip.className = "tag";
      chip.textContent = tag;
      tagsEl.appendChild(chip);
    }
    card.querySelector(".act-done").addEventListener("click", () => markReadingItem(card, item));
    card.querySelector(".act-archive").addEventListener("click", () => archiveReadingItem(card, item));
    if (item.url) card.querySelector(".act-open").addEventListener("click", () => chrome.tabs.create({ url: item.url }));
    list.appendChild(card);
  }
}

async function markReadingItem(card, item) {
  card.classList.add("clearing");
  await send({ action: "markRead", pageId: item.id });
  setTimeout(loadReading, 250);
}

async function archiveReadingItem(card, item) {
  if (!confirm(`ลบ "${item.title}" ออกจากลิสต์?`)) return;
  card.classList.add("clearing");
  await send({ action: "archiveReading", pageId: item.id });
  setTimeout(loadReading, 250);
}

async function quickAddReading() {
  const title = $("reading-quick-title").value.trim();
  if (!title) return;
  const url = $("reading-quick-url").value.trim() || undefined;
  $("reading-quick-title").value = "";
  $("reading-quick-url").value = "";
  await send({ action: "addReading", title, url });
  loadReading();
}

async function loadReading() {
  const status = await send({ action: "status" });
  if (!status?.readingSetup) {
    $("reading-list").innerHTML = `<div class="setup-card">
      <h2>ยังไม่ได้สร้าง database "อ่านทีหลัง"</h2>
      <p>เปิดหน้าตั้งค่า → จัดการ database เพื่อสร้างหรือเชื่อม database</p>
      <button class="setup-btn" id="goto-reading-setup">เปิดหน้าตั้งค่า</button>
    </div>`;
    $("goto-reading-setup").addEventListener("click", () => chrome.runtime.openOptionsPage());
    return;
  }
  const res = await send({ action: "queryUnread" });
  if (res?.ok) {
    readingLoaded = true;
    renderReadingList(res.items);
  } else {
    $("reading-list").innerHTML = `<div class="empty"><span class="empty-mark">${ICONS.warn}</span><div>ดึงข้อมูลไม่ได้</div>
      <div class="empty-sub">${res?.error || ""}</div></div>`;
  }
}

// ---------- สลับ tab แบบ bottom nav ----------

let activeView = "quest";

function switchView(view) {
  if (view === activeView) return;
  activeView = view;
  $("view-quest").hidden = view !== "quest";
  $("view-reading").hidden = view !== "reading";
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  if (view === "reading" && !readingLoaded) loadReading();
}
document.querySelectorAll(".nav-btn").forEach((btn) => btn.addEventListener("click", () => switchView(btn.dataset.view)));

$("reading-quick-add").addEventListener("click", quickAddReading);
$("reading-quick-title").addEventListener("keydown", (e) => { if (e.key === "Enter") quickAddReading(); });
$("reading-quick-url").addEventListener("keydown", (e) => { if (e.key === "Enter") quickAddReading(); });

$("quick-add").addEventListener("click", quickAdd);
$("quick-input").addEventListener("keydown", (e) => { if (e.key === "Enter") quickAdd(); });
$("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("lvl-badge").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("refresh").addEventListener("click", async () => {
  const btn = $("refresh");
  btn.classList.add("spinning");
  try { await (activeView === "reading" ? loadReading() : load()); } finally { btn.classList.remove("spinning"); }
});

makeDropZone($("list"), null); // ลากมาที่ลิสต์วันนี้ = ตั้งเป็นวันนี้

loadOrder().then(load);
