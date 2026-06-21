// reading.js — หน้า "อ่านทีหลัง" เปิดเป็น tab แยก (ไม่ใช่ popup window)
const $ = (id) => document.getElementById(id);

const send = (msg) => chrome.runtime.sendMessage(msg);

function fmtCreated(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("th-TH", { day: "numeric", month: "short" });
}

function renderList(items) {
  const list = $("list");
  list.innerHTML = "";
  if (items.length === 0) {
    list.innerHTML = `<div class="empty">
      <span class="empty-mark">📭</span>
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
    card.querySelector(".act-done").addEventListener("click", () => markRead(card, item));
    card.querySelector(".act-archive").addEventListener("click", () => archive(card, item));
    if (item.url) {
      card.querySelector(".act-open").addEventListener("click", () => chrome.tabs.create({ url: item.url }));
    }
    list.appendChild(card);
  }
}

async function markRead(card, item) {
  card.classList.add("clearing");
  await send({ action: "markRead", pageId: item.id });
  setTimeout(load, 250);
}

async function archive(card, item) {
  if (!confirm(`ลบ "${item.title}" ออกจากลิสต์?`)) return;
  card.classList.add("clearing");
  await send({ action: "archiveReading", pageId: item.id });
  setTimeout(load, 250);
}

async function quickAdd() {
  const title = $("quick-title").value.trim();
  if (!title) return;
  const url = $("quick-url").value.trim() || undefined;
  $("quick-title").value = "";
  $("quick-url").value = "";
  await send({ action: "addReading", title, url });
  load();
}

async function load() {
  const status = await send({ action: "status" });
  if (!status?.readingSetup) {
    $("list").innerHTML = `<div class="setup-card">
      <h2>ยังไม่ได้สร้าง database "อ่านทีหลัง"</h2>
      <p>ไปหน้าจัดการ database เพื่อสร้างหรือเชื่อม</p>
      <button class="setup-btn" id="goto-setup">เปิดหน้าจัดการ database</button>
    </div>`;
    $("goto-setup").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("src/migrate/migrate.html") }));
    return;
  }
  const res = await send({ action: "queryUnread" });
  if (res?.ok) {
    renderList(res.items);
  } else {
    $("list").innerHTML = `<div class="empty"><span class="empty-mark">⚠️</span><div>ดึงข้อมูลไม่ได้</div>
      <div class="empty-sub">${res?.error || ""}</div></div>`;
  }
}

$("quick-add").addEventListener("click", quickAdd);
$("quick-title").addEventListener("keydown", (e) => { if (e.key === "Enter") quickAdd(); });
$("quick-url").addEventListener("keydown", (e) => { if (e.key === "Enter") quickAdd(); });
$("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

load();
