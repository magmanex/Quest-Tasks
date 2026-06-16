// popup.js
import { parseQuickAdd, bangkokToday, addDays } from "./lib/thaiDate.js";
import { levelFromXp } from "./lib/storage.js";

const $ = (id) => document.getElementById(id);

// ทุก action คุยกับ Notion ผ่าน background -> โชว์ syncbar ตลอดที่ยังมี request ค้าง
let pending = 0;
const send = (msg) => {
  pending++;
  $("syncbar").classList.add("on");
  return chrome.runtime.sendMessage(msg).finally(() => {
    if (--pending <= 0) { pending = 0; $("syncbar").classList.remove("on"); }
  });
};

const rankClass = (rank) => "rank-" + ((rank || "B").trim().charAt(0).toUpperCase());

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
  $("streak-text").textContent = `🔥 ${game.streak} วัน`;
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
  return [...tasks].sort((a, b) => idx(a.id) - idx(b.id)); // stable: id ที่ไม่รู้จักคงลำดับเดิม
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
      <span class="empty-mark">🧘</span>
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
        <span class="rank ${rankClass(t.rank)}">${(t.rank || "B").charAt(0)}</span>
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
  row.innerHTML = `<span class="rank ${rankClass(t.rank)}">${(t.rank || "B").charAt(0)}</span><span class="up-item-title"></span><input type="date" class="up-date" title="เปลี่ยนวัน">`;
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
    document.querySelector(".list").innerHTML = `
      <div class="setup-card">
        <h2>ยังไม่ได้เชื่อม Notion</h2>
        <p>ตั้งค่าครั้งแรกเพื่อสร้าง database และเริ่มใช้งาน</p>
        <button class="setup-btn" id="goto-setup">เปิดหน้าตั้งค่า</button>
      </div>`;
    $("goto-setup").addEventListener("click", () => chrome.runtime.openOptionsPage());
    document.querySelector(".quick").style.display = "none";
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
    document.querySelector(".list").innerHTML =
      `<div class="empty"><span class="empty-mark">⚠️</span><div>ดึงข้อมูลไม่ได้</div>
       <div class="empty-sub">${res?.error || ""}</div></div>`;
  }
}

$("quick-add").addEventListener("click", quickAdd);
$("quick-input").addEventListener("keydown", (e) => { if (e.key === "Enter") quickAdd(); });
$("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("lvl-badge").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("refresh").addEventListener("click", async () => {
  const btn = $("refresh");
  btn.classList.add("spinning");
  try { await load(); } finally { btn.classList.remove("spinning"); }
});

makeDropZone($("list"), null); // ลากมาที่ลิสต์วันนี้ = ตั้งเป็นวันนี้

loadOrder().then(load);
