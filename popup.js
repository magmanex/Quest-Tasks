// popup.js
import { parseQuickAdd, bangkokToday } from "./lib/thaiDate.js";
import { levelFromXp } from "./lib/storage.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const rankClass = (rank) => "rank-" + ((rank || "B").trim().charAt(0).toUpperCase());

function fmtDate(iso, today) {
  if (!iso) return "";
  if (iso === today) return "วันนี้";
  const [y, m, d] = iso.split("-").map(Number);
  return `${d}/${m}`;
}

function renderGame(game) {
  const { level, intoLevel, needForNext } = levelFromXp(game.xp);
  $("lvl-num").textContent = level;
  $("xp-fill").style.width = `${Math.min(100, (intoLevel / needForNext) * 100)}%`;
  $("xp-text").textContent = `${intoLevel} / ${needForNext} XP`;
  $("streak-text").textContent = `🔥 ${game.streak} วัน`;
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
  for (const t of tasks) {
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
        <button class="act act-snooze">เลื่อน +1</button>
      </div>`;
    card.querySelector(".card-title").textContent = t.title;
    card.querySelector(".act-done").addEventListener("click", () => complete(card, t));
    card.querySelector(".act-snooze").addEventListener("click", () => snooze(card, t));
    list.appendChild(card);
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
    return;
  }

  if (status.game) renderGame(status.game);
  const res = await send({ action: "queryDue" });
  if (res?.ok) {
    renderList(res.tasks, today);
    if (res.game) renderGame(res.game);
  } else {
    document.querySelector(".list").innerHTML =
      `<div class="empty"><span class="empty-mark">⚠️</span><div>ดึงข้อมูลไม่ได้</div>
       <div class="empty-sub">${res?.error || ""}</div></div>`;
  }
}

$("quick-add").addEventListener("click", quickAdd);
$("quick-input").addEventListener("keydown", (e) => { if (e.key === "Enter") quickAdd(); });
$("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("lvl-badge").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("refresh").addEventListener("click", load);

load();
