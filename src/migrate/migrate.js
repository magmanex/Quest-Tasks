// migrate.js — host (Chrome extension) สำหรับหน้า "จัดการ Database"
// ตัวเองรับผิดชอบแค่ 2 อย่าง: เก็บ/อ่าน config ผ่าน chrome.storage (storage.js) และวาด DOM
// ส่วน orchestration จริง (create/link/check/update/log) อยู่ใน lib/migrate.js ซึ่งไม่แตะ chrome.* เลย
// เผื่อวันหน้าทำ host อื่น (เช่น Scriptable บน iOS) จะ reuse lib/migrate.js + lib/notion.js ได้ทันที
import * as notion from "../lib/notion.js";
import * as migrate from "../lib/migrate.js";
import { getConfig, setConfig } from "../lib/storage.js";

const $ = (id) => document.getElementById(id);

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

// ดึง id ตัวสุดท้าย (32 hex) จาก url หรือ string
function extractId(input) {
  const m = (input || "").replace(/-/g, "").match(/[0-9a-f]{32}/i);
  return m ? m[0].replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5") : input.trim();
}

let token = null;
let questMissing = {};
let readingMissing = {};

$("goto-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

// ---------- สลับโหมด (ใช้ของเดิม/สร้างใหม่) ----------
document.querySelectorAll("[data-mode]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-mode]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const mode = btn.dataset.mode;
    $("mode-new").hidden = mode !== "new";
    $("mode-existing").hidden = mode !== "existing";
  });
});
document.querySelectorAll("[data-reading-mode]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-reading-mode]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const mode = btn.dataset.readingMode;
    $("reading-mode-new").hidden = mode !== "new";
    $("reading-mode-existing").hidden = mode !== "existing";
  });
});

// ---------- โหลด page ที่เข้าถึงได้ ----------
async function loadPages() {
  setStatus($("migrate-status"), "กำลังโหลดรายการ page…", "busy");
  try {
    const pages = await notion.listAccessiblePages(token);
    for (const selId of ["parent-select", "reading-parent-select"]) {
      const sel = $(selId);
      sel.innerHTML = '<option value="">— เลือก page แม่ —</option>';
      pages.forEach(p => {
        const o = document.createElement("option");
        o.value = p.id; o.textContent = p.title;
        sel.appendChild(o);
      });
    }
    setStatus($("migrate-status"),
      pages.length ? `พบ ${pages.length} page` : "ยังไม่พบ page — แชร์ page ให้ integration ก่อนแล้วกดโหลดอีกครั้ง",
      pages.length ? "ok" : "err");
  } catch (e) {
    setStatus($("migrate-status"), `โหลดไม่ได้: ${e.message}`, "err");
  }
}
$("reload-pages").addEventListener("click", loadPages);
$("parent-select").addEventListener("change", (e) => { $("migrate-btn").disabled = !e.target.value; });
$("reading-parent-select").addEventListener("change", (e) => { $("reading-migrate-btn").disabled = !e.target.value; });

// ---------- เขียน migration log (ห่อ lib/migrate.js ให้ผูกกับ chrome.storage) ----------
async function writeLog(parentPageId, log) {
  const cfg = await getConfig();
  try {
    const { logDatabaseId, logDataSourceId } = await migrate.writeLog({
      token, parentPageId, existingLogDataSourceId: cfg.migrationLogDataSourceId, log
    });
    if (logDataSourceId !== cfg.migrationLogDataSourceId) {
      await setConfig({ migrationLogDatabaseId: logDatabaseId, migrationLogDataSourceId: logDataSourceId });
    }
    renderSummary();
  } catch (e) {
    console.warn("[Quest Tasks] log migration failed:", e.message);
  }
}

// ---------- เช็ค & แสดงผล schema (ปุ่มเดียว: พร้อมแล้ว = disable, ไม่พร้อม = กดอัปเดตได้) ----------
function renderSchemaCheck(statusEl, btnEl, { ready, missing }) {
  if (ready) {
    setStatus(statusEl, "schema เป็นปัจจุบันแล้ว ✓ พร้อมทุกฟีเจอร์", "ok");
    btnEl.disabled = true;
    btnEl.textContent = "เป็นปัจจุบันแล้ว ✓";
  } else {
    const names = Object.keys(missing);
    setStatus(statusEl, `ขาด ${names.length} property: ${names.join(", ")}`, "err");
    btnEl.disabled = false;
    btnEl.textContent = `อัปเดต database (+${names.length})`;
  }
}

async function checkQuestSchema() {
  const cfg = await getConfig();
  if (!cfg.dataSourceId) { $("quest-schema-check").hidden = true; return null; }
  $("quest-schema-check").hidden = false;
  setStatus($("quest-schema-status"), "กำลังตรวจสอบ schema…", "busy");
  try {
    const result = await migrate.checkDatabase({
      token, dataSourceId: cfg.dataSourceId, schemaDef: notion.questSchema(cfg.propMap)
    });
    questMissing = result.missing;
    renderSchemaCheck($("quest-schema-status"), $("quest-schema-btn"), result);
    return result;
  } catch (e) {
    setStatus($("quest-schema-status"), `ตรวจสอบไม่ได้: ${e.message}`, "err");
    return null;
  }
}

async function checkReadingSchema() {
  const cfg = await getConfig();
  if (!cfg.readingDataSourceId) { $("reading-schema-check").hidden = true; return null; }
  $("reading-schema-check").hidden = false;
  setStatus($("reading-schema-status"), "กำลังตรวจสอบ schema…", "busy");
  try {
    const result = await migrate.checkDatabase({
      token, dataSourceId: cfg.readingDataSourceId, schemaDef: notion.readingSchema(cfg.readingPropMap)
    });
    readingMissing = result.missing;
    renderSchemaCheck($("reading-schema-status"), $("reading-schema-btn"), result);
    return result;
  } catch (e) {
    setStatus($("reading-schema-status"), `ตรวจสอบไม่ได้: ${e.message}`, "err");
    return null;
  }
}

// ---------- Quest: สร้าง / เชื่อม / อัปเดต ----------
$("migrate-btn").addEventListener("click", async () => {
  const parentId = $("parent-select").value;
  if (!parentId) return;
  const cfg = await getConfig();
  if (cfg.dataSourceId) {
    setStatus($("migrate-status"), "มี database อยู่แล้ว — ล้างการตั้งค่าก่อนถ้าต้องการสร้างใหม่", "err");
    return;
  }
  setStatus($("migrate-status"), "กำลังสร้าง database…", "busy");
  $("migrate-btn").disabled = true;
  try {
    const r = await migrate.createDatabase({
      token, parentPageId: parentId, propMap: cfg.propMap, createFn: notion.createQuestDatabase,
      schemaVersion: notion.QUEST_SCHEMA_VERSION, title: "quest"
    });
    await setConfig({ databaseId: r.databaseId, dataSourceId: r.dataSourceId, questParentPageId: r.parentPageId });
    setStatus($("migrate-status"), "สร้าง database สำเร็จ 🎉", "ok");
    await chrome.runtime.sendMessage({ action: "rescheduleAlarm" });
    await chrome.runtime.sendMessage({ action: "refreshBadge" });
    renderSummary();
    await checkQuestSchema();
    await writeLog(r.parentPageId, r.log);
  } catch (e) {
    setStatus($("migrate-status"), `สร้างไม่สำเร็จ: ${e.message}`, "err");
    $("migrate-btn").disabled = false;
  }
});

$("link-btn").addEventListener("click", async () => {
  const dbId = extractId($("existing-db").value);
  if (!dbId) return setStatus($("migrate-status"), "ใส่ database id หรือ url", "err");
  const cfg = await getConfig();
  setStatus($("migrate-status"), "กำลังเชื่อม…", "busy");
  try {
    const r = await migrate.linkDatabase({
      token, databaseId: dbId, schemaDef: notion.questSchema(cfg.propMap), schemaVersion: notion.QUEST_SCHEMA_VERSION, title: "quest"
    });
    await setConfig({ databaseId: dbId, dataSourceId: r.dataSourceId, questParentPageId: r.parentPageId });
    setStatus($("migrate-status"), "เชื่อม database สำเร็จ ✓ (ตรวจชื่อ property ให้ตรงกับที่ตั้งไว้ด้วย)", "ok");
    await chrome.runtime.sendMessage({ action: "rescheduleAlarm" });
    await chrome.runtime.sendMessage({ action: "refreshBadge" });
    renderSummary();
    await checkQuestSchema();
    await writeLog(r.parentPageId, r.log);
  } catch (e) {
    setStatus($("migrate-status"), `เชื่อมไม่ได้: ${e.message}`, "err");
  }
});

$("quest-schema-btn").addEventListener("click", async () => {
  const cfg = await getConfig();
  $("quest-schema-btn").disabled = true;
  setStatus($("quest-schema-status"), "กำลังอัปเดต…", "busy");
  try {
    const r = await migrate.updateDatabase({
      token, dataSourceId: cfg.dataSourceId, missing: questMissing,
      schemaVersion: notion.QUEST_SCHEMA_VERSION, title: "quest"
    });
    await writeLog(cfg.questParentPageId, r.log);
    await checkQuestSchema();
  } catch (e) {
    setStatus($("quest-schema-status"), `อัปเดตไม่สำเร็จ: ${e.message}`, "err");
    $("quest-schema-btn").disabled = false;
  }
});

// ---------- Reading: สร้าง / เชื่อม / อัปเดต ----------
$("reading-migrate-btn").addEventListener("click", async () => {
  const parentId = $("reading-parent-select").value;
  if (!parentId) return;
  const cfg = await getConfig();
  if (cfg.readingDataSourceId) {
    setStatus($("reading-migrate-status"), "มี database อยู่แล้ว — ล้างการตั้งค่าก่อนถ้าต้องการสร้างใหม่", "err");
    return;
  }
  setStatus($("reading-migrate-status"), "กำลังสร้าง database…", "busy");
  $("reading-migrate-btn").disabled = true;
  try {
    const r = await migrate.createDatabase({
      token, parentPageId: parentId, propMap: cfg.readingPropMap, createFn: notion.createReadingDatabase,
      schemaVersion: notion.READING_SCHEMA_VERSION, title: "อ่านทีหลัง"
    });
    await setConfig({ readingDatabaseId: r.databaseId, readingDataSourceId: r.dataSourceId, readingParentPageId: r.parentPageId });
    setStatus($("reading-migrate-status"), "สร้าง database สำเร็จ 🎉", "ok");
    renderSummary();
    await checkReadingSchema();
    await writeLog(r.parentPageId, r.log);
  } catch (e) {
    setStatus($("reading-migrate-status"), `สร้างไม่สำเร็จ: ${e.message}`, "err");
    $("reading-migrate-btn").disabled = false;
  }
});

$("reading-link-btn").addEventListener("click", async () => {
  const dbId = extractId($("reading-existing-db").value);
  if (!dbId) return setStatus($("reading-migrate-status"), "ใส่ database id หรือ url", "err");
  const cfg = await getConfig();
  setStatus($("reading-migrate-status"), "กำลังเชื่อม…", "busy");
  try {
    const r = await migrate.linkDatabase({
      token, databaseId: dbId, schemaDef: notion.readingSchema(cfg.readingPropMap),
      schemaVersion: notion.READING_SCHEMA_VERSION, title: "อ่านทีหลัง"
    });
    await setConfig({ readingDatabaseId: dbId, readingDataSourceId: r.dataSourceId, readingParentPageId: r.parentPageId });
    setStatus($("reading-migrate-status"), "เชื่อม database สำเร็จ ✓ (ตรวจชื่อ property ให้ตรงกับที่ตั้งไว้ด้วย)", "ok");
    renderSummary();
    await checkReadingSchema();
    await writeLog(r.parentPageId, r.log);
  } catch (e) {
    setStatus($("reading-migrate-status"), `เชื่อมไม่ได้: ${e.message}`, "err");
  }
});

$("reading-schema-btn").addEventListener("click", async () => {
  const cfg = await getConfig();
  $("reading-schema-btn").disabled = true;
  setStatus($("reading-schema-status"), "กำลังอัปเดต…", "busy");
  try {
    const r = await migrate.updateDatabase({
      token, dataSourceId: cfg.readingDataSourceId, missing: readingMissing,
      schemaVersion: notion.READING_SCHEMA_VERSION, title: "อ่านทีหลัง"
    });
    await writeLog(cfg.readingParentPageId, r.log);
    await checkReadingSchema();
  } catch (e) {
    setStatus($("reading-schema-status"), `อัปเดตไม่สำเร็จ: ${e.message}`, "err");
    $("reading-schema-btn").disabled = false;
  }
});

// ---------- สรุปสถานะ ----------
async function renderSummary() {
  const cfg = await getConfig();
  const hasAny = cfg.dataSourceId || cfg.readingDataSourceId;
  $("summary").hidden = !hasAny;
  if (!hasAny) return;

  $("sum-ds").textContent = cfg.dataSourceId || "—";
  $("sum-reading-ds").textContent = cfg.readingDataSourceId || "—";

  $("open-db").hidden = !cfg.databaseId;
  $("open-db").onclick = () => chrome.tabs.create({ url: `https://www.notion.so/${cfg.databaseId.replace(/-/g, "")}` });

  $("open-reading-db").hidden = !cfg.readingDatabaseId;
  $("open-reading-db").onclick = () => chrome.tabs.create({ url: `https://www.notion.so/${cfg.readingDatabaseId.replace(/-/g, "")}` });

  $("open-log").hidden = !cfg.migrationLogDatabaseId;
  $("open-log").onclick = () => chrome.tabs.create({ url: `https://www.notion.so/${cfg.migrationLogDatabaseId.replace(/-/g, "")}` });
}

// ---------- init ----------
(async function init() {
  const cfg = await getConfig();
  if (!cfg.token) {
    $("no-token-notice").hidden = false;
    document.querySelectorAll(".block").forEach(b => b.dataset.locked = "true");
    return;
  }
  token = cfg.token;
  loadPages();
  await checkQuestSchema();
  await checkReadingSchema();
  renderSummary();
})();
