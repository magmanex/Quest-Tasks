// quest.js — ตรรกะหน้าต่าง quest แบบเกม
import { bangkokToday } from "../lib/thaiDate.js";
import { levelFromXp, rankLetter } from "../lib/storage.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const today = bangkokToday();

// เสียงสำเร็จสั้น ๆ สังเคราะห์เอง (ไม่ต้องมีไฟล์เสียง)
function chime() {
  if (reduceMotion) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = [523.25, 659.25, 783.99]; // C5 E5 G5
    notes.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "triangle"; o.frequency.value = f;
      o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.08;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.start(t); o.stop(t + 0.4);
    });
  } catch (_) { /* เงียบไว้ถ้าเล่นเสียงไม่ได้ */ }
}

function burst(x, y) {
  if (reduceMotion) return;
  const colors = ["#e0a106", "#f4c542", "#4fb286", "#8a7cf2"];
  for (let i = 0; i < 14; i++) {
    const p = document.createElement("div");
    p.className = "burst";
    p.style.background = colors[i % colors.length];
    p.style.left = x + "px"; p.style.top = y + "px";
    document.body.appendChild(p);
    const ang = Math.random() * Math.PI * 2, dist = 40 + Math.random() * 70;
    p.animate(
      [{ transform: "translate(0,0) scale(1)", opacity: 1 },
       { transform: `translate(${Math.cos(ang)*dist}px, ${Math.sin(ang)*dist}px) scale(0)`, opacity: 0 }],
      { duration: 600 + Math.random()*300, easing: "cubic-bezier(.2,.8,.2,1)" }
    ).onfinish = () => p.remove();
  }
}

function renderGame(game) {
  if (!game) return;
  const { level, intoLevel, needForNext } = levelFromXp(game.xp);
  $("q-lvl").textContent = level;
  $("q-xp").style.width = `${Math.min(100, (intoLevel / needForNext) * 100)}%`;
  $("q-streak").textContent = `🔥 ${game.streak}`;
}

const rankSuffix = rankLetter;

function fmtMeta(t) {
  const overdue = t.date && t.date < today;
  if (!t.date) return { text: "ไม่มีกำหนด", late: false };
  if (overdue) {
    const [y, m, d] = t.date.slice(0, 10).split("-").map(Number);
    return { text: `เลยกำหนดมาตั้งแต่ ${d}/${m}`, late: true };
  }
  const time = t.date.length > 10 ? " " + t.date.slice(11, 16) : "";
  return { text: "ครบกำหนดวันนี้" + time, late: false };
}

function makeCard(t) {
  const card = document.createElement("div");
  card.className = `qcard rank${rankSuffix(t.rank)}`;
  const meta = fmtMeta(t);
  const actions = t.repeat
    ? `<button class="qbtn qbtn-done">✓ เสร็จวันนี้</button>
       <button class="qbtn qbtn-snooze qbtn-close" title="ปิดงานนี้ ไม่ทำซ้ำอีก">ปิดงาน</button>`
    : `<button class="qbtn qbtn-done">✓ เคลียร์ quest</button>
       <button class="qbtn qbtn-snooze">เลื่อนไปพรุ่งนี้</button>`;
  card.innerHTML = `
    <div class="qcard-head">
      <span class="rank rank-${rankSuffix(t.rank)}">${t.rank || "B"}</span>
      <span class="qcard-title"></span>
      ${t.repeat ? `<span class="qrepeat">🔁 ${t.repeat}</span>` : ""}
    </div>
    <div class="qcard-meta ${meta.late ? "late" : ""}">${meta.text}</div>
    <div class="qcard-actions">${actions}</div>
    <div class="stamp">CLEARED</div>`;
  card.querySelector(".qcard-title").textContent = t.title;
  card.querySelector(".qbtn-done").addEventListener("click", (e) => clearQuest(card, t, e));
  // recurring: ปุ่มที่สองคือ "ปิดงาน" (complete จริง); ไม่ใช่ recurring คือ "เลื่อน"
  card.querySelector(".qbtn-snooze").addEventListener("click", () =>
    t.repeat ? clearQuest(card, t, null, true) : snoozeQuest(card, t));
  return card;
}

let remaining = 0;

// close=true (recurring): ปิดงานถาวร (complete จริง). recurring + close=false: เสร็จวันนี้ (เลื่อน occurrence)
async function clearQuest(card, task, evt, close) {
  const rect = card.getBoundingClientRect();
  card.classList.add("cleared");
  chime();
  burst(rect.left + rect.width / 2, rect.top + rect.height / 2);

  const msg = (task.repeat && !close)
    ? { action: "completeRecurring", pageId: task.id, rank: task.rank, repeat: task.repeat, date: task.date }
    : { action: "complete", pageId: task.id, rank: task.rank };
  const res = await send(msg);
  if (res?.ok) {
    renderGame(res.game);
    remaining = res.remaining;
  }
  setTimeout(() => {
    card.remove();
    if (remaining <= 0) showVictory(res?.game);
  }, reduceMotion ? 0 : 1150);
}

async function snoozeQuest(card, task) {
  card.style.opacity = "0.4";
  const res = await send({ action: "snooze", pageId: task.id, days: 1 });
  if (res?.ok) remaining = res.remaining;
  card.remove();
  if (remaining <= 0) showVictory();
}

function showVictory(game) {
  $("qlist").hidden = true;
  $("qcount").textContent = "0";
  const v = $("qvictory");
  v.hidden = false;
  if (game) $("qvictory-sub").textContent = `LV ${levelFromXp(game.xp).level} · streak ${game.streak} วัน`;
}

$("qclose").addEventListener("click", () => window.close());

async function load() {
  const res = await send({ action: "queryDue" });
  if (!res?.ok) { showVictory(); return; }
  remaining = res.tasks.length;
  $("qcount").textContent = remaining;
  renderGame(res.game);
  const list = $("qlist");
  list.innerHTML = "";
  if (remaining === 0) { showVictory(res.game); return; }
  res.tasks.forEach((t, i) => {
    const c = makeCard(t);
    c.style.animationDelay = `${i * 0.06}s`;
    list.appendChild(c);
  });
}

load();
