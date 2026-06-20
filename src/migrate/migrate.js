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

// ---------- สลับโหมด (ใช้ของเดิม/สร้างใหม่) — ใช้ร่วมกันทั้ง quest + reading ----------
document.querySelectorAll("[data-mode]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-mode]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const mode = btn.dataset.mode;
    $("mode-new").hidden = mode !== "new";
    $("mode-existing").hidden = mode !== "existing";
  });
});

// ---------- โหลด page ที่เข้าถึงได้ ----------
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
    setStatus($("migrate-status"),
      pages.length ? `พบ ${pages.length} page` : "ยังไม่พบ page — แชร์ page ให้ integration ก่อนแล้วกดโหลดอีกครั้ง",
      pages.length ? "ok" : "err");
  } catch (e) {
    setStatus($("migrate-status"), `โหลดไม่ได้: ${e.message}`, "err");
  }
}
$("reload-pages").addEventListener("click", loadPages);
$("parent-select").addEventListener("change", (e) => { $("migrate-btn").disabled = !e.target.value; });

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

// ---------- Migrate ทั้งหมดในขั้นตอนเดียว: สร้างใหม่ (quest + reading พร้อมกัน) ----------
$("migrate-btn").addEventListener("click", async () => {
  const parentId = $("parent-select").value;
  if (!parentId) return;
  setStatus($("migrate-status"), "กำลังสร้าง database…", "busy");
  $("migrate-btn").disabled = true;
  const notes = [];
  try {
    let cfg = await getConfig();
    if (!cfg.dataSourceId) {
      const r = await migrate.createDatabase({
        token, parentPageId: parentId, propMap: cfg.propMap, createFn: notion.createQuestDatabase,
        schemaVersion: notion.QUEST_SCHEMA_VERSION, title: "quest"
      });
      await setConfig({ databaseId: r.databaseId, dataSourceId: r.dataSourceId, questParentPageId: r.parentPageId });
      await writeLog(r.parentPageId, r.log);
      notes.push("สร้าง quest สำเร็จ 🎉");
    } else {
      notes.push("quest มีอยู่แล้ว — ข้าม");
    }

    cfg = await getConfig();
    if (!cfg.readingDataSourceId) {
      const r = await migrate.createDatabase({
        token, parentPageId: parentId, propMap: cfg.readingPropMap, createFn: notion.createReadingDatabase,
        schemaVersion: notion.READING_SCHEMA_VERSION, title: "อ่านทีหลัง"
      });
      await setConfig({ readingDatabaseId: r.databaseId, readingDataSourceId: r.dataSourceId, readingParentPageId: r.parentPageId });
      await writeLog(r.parentPageId, r.log);
      notes.push("สร้าง อ่านทีหลัง สำเร็จ 🎉");
    } else {
      notes.push("อ่านทีหลัง มีอยู่แล้ว — ข้าม");
    }

    setStatus($("migrate-status"), notes.join(" · "), "ok");
    await chrome.runtime.sendMessage({ action: "rescheduleAlarm" });
    await chrome.runtime.sendMessage({ action: "refreshBadge" });
    renderSummary();
    await checkQuestSchema();
    await checkReadingSchema();
  } catch (e) {
    setStatus($("migrate-status"), `สร้างไม่สำเร็จ: ${e.message}`, "err");
  } finally {
    $("migrate-btn").disabled = false;
  }
});

// ---------- Migrate ทั้งหมดในขั้นตอนเดียว: เชื่อม database เดิม (เว้นช่องไหนว่าง = ข้ามตัวนั้น) ----------
$("link-btn").addEventListener("click", async () => {
  const questId = extractId($("existing-db").value);
  const readingId = extractId($("reading-existing-db").value);
  if (!questId && !readingId) return setStatus($("migrate-status"), "ใส่ database id อย่างน้อย 1 อัน", "err");
  setStatus($("migrate-status"), "กำลังเชื่อม…", "busy");
  const notes = [];
  try {
    if (questId) {
      const cfg = await getConfig();
      const r = await migrate.linkDatabase({
        token, databaseId: questId, schemaDef: notion.questSchema(cfg.propMap), schemaVersion: notion.QUEST_SCHEMA_VERSION, title: "quest"
      });
      await setConfig({ databaseId: questId, dataSourceId: r.dataSourceId, questParentPageId: r.parentPageId });
      await writeLog(r.parentPageId, r.log);
      notes.push(`เชื่อม quest ${r.ready ? "✓ ครบ" : "(ขาด property — เลื่อนลงไปอัปเดตได้)"}`);
    }
    if (readingId) {
      const cfg = await getConfig();
      const r = await migrate.linkDatabase({
        token, databaseId: readingId, schemaDef: notion.readingSchema(cfg.readingPropMap),
        schemaVersion: notion.READING_SCHEMA_VERSION, title: "อ่านทีหลัง"
      });
      await setConfig({ readingDatabaseId: readingId, readingDataSourceId: r.dataSourceId, readingParentPageId: r.parentPageId });
      await writeLog(r.parentPageId, r.log);
      notes.push(`เชื่อม อ่านทีหลัง ${r.ready ? "✓ ครบ" : "(ขาด property — เลื่อนลงไปอัปเดตได้)"}`);
    }
    setStatus($("migrate-status"), notes.join(" · "), "ok");
    await chrome.runtime.sendMessage({ action: "rescheduleAlarm" });
    await chrome.runtime.sendMessage({ action: "refreshBadge" });
    renderSummary();
    await checkQuestSchema();
    await checkReadingSchema();
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
        <div class="log-time"></div>`;
      item.querySelector(".log-title").textContent = row.eventTitle;
      item.querySelector(".log-detail").textContent = row.detail;
      item.querySelector(".log-time").textContent = fmtLogTime(row.createdTime);
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
  renderSummary();
  renderLog();
})();
