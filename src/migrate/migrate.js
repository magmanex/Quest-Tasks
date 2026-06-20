// migrate.js — host (Chrome extension) สำหรับหน้า "จัดการ Database"
// ตัวเองรับผิดชอบแค่ 2 อย่าง: เก็บ/อ่าน config ผ่าน chrome.storage (storage.js) และวาด DOM
// ส่วน orchestration จริง (create/link/check/update/log) อยู่ใน lib/migrate.js ซึ่งไม่แตะ chrome.* เลย
// เผื่อวันหน้าทำ host อื่น (เช่น Scriptable บน iOS) จะ reuse lib/migrate.js + lib/notion.js ได้ทันที
import * as notion from "../lib/notion.js";
import * as migrate from "../lib/migrate.js";
import { getConfig, setConfig } from "../lib/storage.js";
import { bangkokToday } from "../lib/thaiDate.js";

const $ = (id) => document.getElementById(id);

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

// ดึง id ตัวสุดท้าย (32 hex) จาก url หรือ string — คืน "" ถ้าไม่มี input (ให้ผู้เรียก skip เอง)
function extractId(input) {
  const trimmed = (input || "").trim();
  if (!trimmed) return "";
  const m = trimmed.replace(/-/g, "").match(/[0-9a-f]{32}/i);
  return m ? m[0].replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5") : trimmed;
}

let token = null;
let questMissing = {};
let readingMissing = {};

$("goto-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

// ปุ่ม Migrate กดได้เมื่อเลือก page แม่ หรือใส่ database id ไว้อย่างน้อย 1 ช่อง
function refreshMigrateBtnEnabled() {
  $("migrate-btn").disabled = !(
    $("parent-select").value || $("existing-db").value.trim() || $("reading-existing-db").value.trim()
  );
}
$("parent-select").addEventListener("change", refreshMigrateBtnEnabled);
$("existing-db").addEventListener("input", refreshMigrateBtnEnabled);
$("reading-existing-db").addEventListener("input", refreshMigrateBtnEnabled);

// ---------- โหลด page ที่เข้าถึงได้ — จำ page ที่เคยเลือกไว้แล้ว (จาก quest/reading ที่ migrate ไปแล้ว) ----------
async function loadPages() {
  setStatus($("migrate-status"), "กำลังโหลดรายการ page…", "busy");
  try {
    const pages = await notion.listAccessiblePages(token);
    const sel = $("parent-select");
    sel.innerHTML = '<option value="">— เลือก page แม่ —</option>';
    pages.forEach(p => {
      const o = document.createElement("option");
      o.value = p.id; o.textContent = p.title;
      sel.appendChild(o);
    });
    const cfg = await getConfig();
    const remembered = cfg.questParentPageId || cfg.readingParentPageId;
    if (remembered) sel.value = remembered; // ถ้า page นี้ยังอยู่ในลิสต์ — ไม่ต้องเลือกใหม่ทุกครั้งที่เข้าหน้า
    refreshMigrateBtnEnabled();
    setStatus($("migrate-status"),
      pages.length ? `พบ ${pages.length} page` : "ยังไม่พบ page — แชร์ page ให้ integration ก่อนแล้วกดโหลดอีกครั้ง",
      pages.length ? "ok" : "err");
  } catch (e) {
    setStatus($("migrate-status"), `โหลดไม่ได้: ${e.message}`, "err");
  }
}
$("reload-pages").addEventListener("click", loadPages);

// ---------- ซ่อนฟอร์ม migrate ทั้งหมดเมื่อทั้ง quest + reading ตั้งค่าครบแล้ว ----------
async function refreshMigrateFormVisibility() {
  const cfg = await getConfig();
  const done = Boolean(cfg.dataSourceId && cfg.readingDataSourceId);
  $("migrate-form").hidden = done;
  $("migrate-done-notice").hidden = !done;
}

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
    renderLog();
  } catch (e) {
    console.warn("[Quest Tasks] log migration failed:", e.message);
    const el = $("migrate-status");
    el.textContent += ` (หมายเหตุ: บันทึก migration log ไม่สำเร็จ — ${e.message})`;
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

// ---------- Migrate ทั้งหมดในขั้นตอนเดียว ----------
// ต่อ database (quest/reading): มี id ที่ผู้ใช้วางไว้ → เชื่อมด้วย id นั้น
//                               ไม่มี id แต่ยังไม่เคย migrate + เลือก page แม่ไว้ → สร้างใหม่ใต้ page นั้น
//                               migrate ไปแล้ว (มี dataSourceId อยู่แล้ว) และไม่ได้วาง id ใหม่ → ข้าม
async function migrateOne({ existingId, hasDataSourceId, parentId, createArgs, linkArgs, skipLabel, doneLabel }) {
  if (existingId) {
    const r = await migrate.linkDatabase(linkArgs(existingId));
    return { r, note: r.ready ? `${doneLabel} ✓ ครบ` : `${doneLabel} (ขาด property — เลื่อนลงไปอัปเดตได้)`, linked: true };
  }
  if (!hasDataSourceId && parentId) {
    const r = await migrate.createDatabase(createArgs(parentId));
    return { r, note: `${doneLabel} สำเร็จ 🎉`, linked: false };
  }
  return { r: null, note: hasDataSourceId ? `${skipLabel} มีอยู่แล้ว — ข้าม` : null, linked: false };
}

$("migrate-btn").addEventListener("click", async () => {
  const parentId = $("parent-select").value;
  const questId = extractId($("existing-db").value);
  const readingId = extractId($("reading-existing-db").value);
  setStatus($("migrate-status"), "กำลัง migrate…", "busy");
  $("migrate-btn").disabled = true;
  const notes = [];
  const todayISO = bangkokToday();
  try {
    let cfg = await getConfig();
    const quest = await migrateOne({
      existingId: questId, hasDataSourceId: Boolean(cfg.dataSourceId), parentId, skipLabel: "quest", doneLabel: "quest",
      createArgs: (pid) => ({
        token, parentPageId: pid, propMap: cfg.propMap, createFn: notion.createQuestDatabase,
        schemaVersion: notion.QUEST_SCHEMA_VERSION, releaseDate: notion.QUEST_SCHEMA_RELEASES[notion.QUEST_SCHEMA_VERSION],
        updatedDateISO: todayISO, title: "quest"
      }),
      linkArgs: (id) => ({
        token, databaseId: id, schemaDef: notion.questSchema(cfg.propMap), schemaVersion: notion.QUEST_SCHEMA_VERSION,
        releaseDate: notion.QUEST_SCHEMA_RELEASES[notion.QUEST_SCHEMA_VERSION], updatedDateISO: todayISO, title: "quest"
      })
    });
    if (quest.r) {
      await setConfig({ databaseId: quest.r.databaseId, dataSourceId: quest.r.dataSourceId, questParentPageId: quest.r.parentPageId });
      await writeLog(quest.r.parentPageId, quest.r.log);
    }
    if (quest.note) notes.push(quest.note);

    cfg = await getConfig();
    const reading = await migrateOne({
      existingId: readingId, hasDataSourceId: Boolean(cfg.readingDataSourceId), parentId, skipLabel: "อ่านทีหลัง", doneLabel: "อ่านทีหลัง",
      createArgs: (pid) => ({
        token, parentPageId: pid, propMap: cfg.readingPropMap, createFn: notion.createReadingDatabase,
        schemaVersion: notion.READING_SCHEMA_VERSION, releaseDate: notion.READING_SCHEMA_RELEASES[notion.READING_SCHEMA_VERSION],
        updatedDateISO: todayISO, title: "อ่านทีหลัง"
      }),
      linkArgs: (id) => ({
        token, databaseId: id, schemaDef: notion.readingSchema(cfg.readingPropMap), schemaVersion: notion.READING_SCHEMA_VERSION,
        releaseDate: notion.READING_SCHEMA_RELEASES[notion.READING_SCHEMA_VERSION], updatedDateISO: todayISO, title: "อ่านทีหลัง"
      })
    });
    if (reading.r) {
      await setConfig({ readingDatabaseId: reading.r.databaseId, readingDataSourceId: reading.r.dataSourceId, readingParentPageId: reading.r.parentPageId });
      await writeLog(reading.r.parentPageId, reading.r.log);
    }
    if (reading.note) notes.push(reading.note);

    setStatus($("migrate-status"), notes.length ? notes.join(" · ") : "ไม่มีอะไรให้ทำ — ลองเลือก page หรือใส่ database id", notes.length ? "ok" : "err");
    await chrome.runtime.sendMessage({ action: "rescheduleAlarm" });
    await chrome.runtime.sendMessage({ action: "refreshBadge" });
    renderSummary();
    await checkQuestSchema();
    await checkReadingSchema();
    await refreshMigrateFormVisibility();
  } catch (e) {
    setStatus($("migrate-status"), `migrate ไม่สำเร็จ: ${e.message}`, "err");
  } finally {
    $("migrate-btn").disabled = false;
    refreshMigrateBtnEnabled();
  }
});

$("quest-schema-btn").addEventListener("click", async () => {
  const cfg = await getConfig();
  $("quest-schema-btn").disabled = true;
  setStatus($("quest-schema-status"), "กำลังอัปเดต…", "busy");
  try {
    const r = await migrate.updateDatabase({
      token, dataSourceId: cfg.dataSourceId, missing: questMissing,
      schemaVersion: notion.QUEST_SCHEMA_VERSION,
      releaseDate: notion.QUEST_SCHEMA_RELEASES[notion.QUEST_SCHEMA_VERSION],
      updatedDateISO: bangkokToday(), title: "quest"
    });
    await writeLog(cfg.questParentPageId, r.log);
    await checkQuestSchema();
  } catch (e) {
    setStatus($("quest-schema-status"), `อัปเดตไม่สำเร็จ: ${e.message}`, "err");
    $("quest-schema-btn").disabled = false;
  }
});

$("reading-schema-btn").addEventListener("click", async () => {
  const cfg = await getConfig();
  $("reading-schema-btn").disabled = true;
  setStatus($("reading-schema-status"), "กำลังอัปเดต…", "busy");
  try {
    const r = await migrate.updateDatabase({
      token, dataSourceId: cfg.readingDataSourceId, missing: readingMissing,
      schemaVersion: notion.READING_SCHEMA_VERSION,
      releaseDate: notion.READING_SCHEMA_RELEASES[notion.READING_SCHEMA_VERSION],
      updatedDateISO: bangkokToday(), title: "อ่านทีหลัง"
    });
    await writeLog(cfg.readingParentPageId, r.log);
    await checkReadingSchema();
  } catch (e) {
    setStatus($("reading-schema-status"), `อัปเดตไม่สำเร็จ: ${e.message}`, "err");
    $("reading-schema-btn").disabled = false;
  }
});

// ---------- Migration Log: ดึงจาก Notion มาแสดง ----------
function fmtLogTime(iso) {
  return new Date(iso).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
}

async function renderLog() {
  const cfg = await getConfig();
  const container = $("log-list");
  if (!cfg.migrationLogDataSourceId) {
    container.innerHTML = `<div class="empty-sub">ยังไม่มี log — จะสร้างอัตโนมัติตอน migrate ครั้งแรก</div>`;
    return;
  }
  container.innerHTML = `<div class="status busy">กำลังโหลด log…</div>`;
  try {
    const rows = await migrate.fetchLog({ token, dataSourceId: cfg.migrationLogDataSourceId });
    if (rows.length === 0) {
      container.innerHTML = `<div class="empty-sub">ยังไม่มี log</div>`;
      return;
    }
    container.innerHTML = "";
    for (const row of rows) {
      const item = document.createElement("div");
      item.className = "log-row";
      item.innerHTML = `
        <div class="log-row-top">
          <span class="log-title"></span>
          <span class="log-version">v${row.version ?? "?"}</span>
        </div>
        <div class="log-detail"></div>
        <div class="log-dates"></div>`;
      item.querySelector(".log-title").textContent = row.eventTitle;
      item.querySelector(".log-detail").textContent = row.detail;
      item.querySelector(".log-dates").textContent =
        `อัปเดตเมื่อ ${row.updatedDate || "—"} · เวอร์ชันนี้ออกเมื่อ ${row.releaseDate || "—"} · บันทึก ${fmtLogTime(row.createdTime)}`;
      container.appendChild(item);
    }
  } catch (e) {
    container.innerHTML = `<div class="status err">โหลด log ไม่ได้: ${e.message}</div>`;
  }
}
$("refresh-log").addEventListener("click", renderLog);

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
  await refreshMigrateFormVisibility();
  renderSummary();
  renderLog();
})();
