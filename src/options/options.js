// options.js — หน้าตั้งค่า + flow migrate ครั้งแรก
// หน้านี้เป็น extension page จึงเรียก notion.js ตรงได้ (ไม่ติด CORS)
import * as notion from "../lib/notion.js";
import { getConfig, setConfig } from "../lib/storage.js";

const $ = (id) => document.getElementById(id);

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}
function lock(sectionId, locked) {
  $(sectionId).dataset.locked = locked ? "true" : "false";
}

// ดึง id ตัวสุดท้าย (32 hex) จาก url หรือ string
function extractId(input) {
  const m = (input || "").replace(/-/g, "").match(/[0-9a-f]{32}/i);
  return m ? m[0].replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5") : input.trim();
}

let token = null;

// ---------- STEP 1: ทดสอบ token ----------
$("test-btn").addEventListener("click", async () => {
  const t = $("token").value.trim();
  if (!t) return setStatus($("token-status"), "ใส่ token ก่อน", "err");
  setStatus($("token-status"), "กำลังตรวจสอบ…", "busy");
  try {
    const me = await notion.whoAmI(t);
    token = t;
    await setConfig({ token: t });
    setStatus($("token-status"), `เชื่อมต่อสำเร็จ: ${me.name || me.bot?.owner?.type || "integration"}`, "ok");
    lock("step2", false);
    lock("step3", false);
    lock("step4", false);
    loadPages();
  } catch (e) {
    setStatus($("token-status"), `ล้มเหลว: ${e.message}`, "err");
  }
});

// ---------- STEP 2: สลับโหมด ----------
document.querySelectorAll("#step2 .seg-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#step2 .seg-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const mode = btn.dataset.mode;
    $("mode-new").hidden = mode !== "new";
    $("mode-existing").hidden = mode !== "existing";
  });
});

// ---------- STEP 4: สลับโหมด ----------
document.querySelectorAll("#step4 .seg-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#step4 .seg-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const mode = btn.dataset.readingMode;
    $("reading-mode-new").hidden = mode !== "new";
    $("reading-mode-existing").hidden = mode !== "existing";
  });
});

// โหลด page ที่เข้าถึงได้ (ใช้ร่วมกันทั้ง quest db และ reading db)
async function loadPages() {
  if (!token) return;
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
$("parent-select").addEventListener("change", (e) => {
  $("migrate-btn").disabled = !e.target.value;
});
$("reading-parent-select").addEventListener("change", (e) => {
  $("reading-migrate-btn").disabled = !e.target.value;
});

// สร้าง database (idempotent)
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
    const { databaseId, dataSourceId, parentPageId } = await notion.createQuestDatabase(token, parentId, cfg.propMap);
    await setConfig({ databaseId, dataSourceId, questParentPageId: parentPageId });
    setStatus($("migrate-status"), "สร้าง database สำเร็จ 🎉", "ok");
    await chrome.runtime.sendMessage({ action: "rescheduleAlarm" });
    await chrome.runtime.sendMessage({ action: "refreshBadge" });
    renderSummary();
    await checkQuestSchema();
    await writeMigrationLog(
      parentPageId, `สร้าง quest database ใหม่ (v${notion.QUEST_SCHEMA_VERSION})`,
      notion.QUEST_SCHEMA_VERSION, "สร้างใหม่ — schema ครบทุก property ตั้งแต่สร้าง"
    );
  } catch (e) {
    setStatus($("migrate-status"), `สร้างไม่สำเร็จ: ${e.message}`, "err");
    $("migrate-btn").disabled = false;
  }
});

// เชื่อม database เดิม
$("link-btn").addEventListener("click", async () => {
  const dbId = extractId($("existing-db").value);
  if (!dbId) return setStatus($("migrate-status"), "ใส่ database id หรือ url", "err");
  setStatus($("migrate-status"), "กำลังเชื่อม…", "busy");
  try {
    const { dataSourceId, parentPageId } = await notion.resolveDataSourceId(token, dbId);
    await setConfig({ databaseId: dbId, dataSourceId, questParentPageId: parentPageId });
    setStatus($("migrate-status"), "เชื่อม database สำเร็จ ✓ (ตรวจชื่อ property ให้ตรงกับที่ตั้งไว้ด้วย)", "ok");
    await chrome.runtime.sendMessage({ action: "rescheduleAlarm" });
    await chrome.runtime.sendMessage({ action: "refreshBadge" });
    renderSummary();
    const result = await checkQuestSchema();
    const detail = result?.ready
      ? `เชื่อม database ที่มีอยู่ — schema ตรง v${notion.QUEST_SCHEMA_VERSION} ครบทุก property`
      : `เชื่อม database ที่มีอยู่ — ขาด property: ${Object.keys(result?.missing || {}).join(", ")} (กดอัปเดตเพื่อเติมให้ครบ)`;
    await writeMigrationLog(
      parentPageId, `เชื่อม quest database (v${notion.QUEST_SCHEMA_VERSION})`,
      notion.QUEST_SCHEMA_VERSION, detail
    );
  } catch (e) {
    setStatus($("migrate-status"), `เชื่อมไม่ได้: ${e.message}`, "err");
  }
});

// สร้าง reading database (idempotent)
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
    const { databaseId, dataSourceId, parentPageId } = await notion.createReadingDatabase(token, parentId, cfg.readingPropMap);
    await setConfig({ readingDatabaseId: databaseId, readingDataSourceId: dataSourceId, readingParentPageId: parentPageId });
    setStatus($("reading-migrate-status"), "สร้าง database สำเร็จ 🎉", "ok");
    await checkReadingSchema();
    await writeMigrationLog(
      parentPageId, `สร้าง อ่านทีหลัง database ใหม่ (v${notion.READING_SCHEMA_VERSION})`,
      notion.READING_SCHEMA_VERSION, "สร้างใหม่ — schema ครบทุก property ตั้งแต่สร้าง"
    );
  } catch (e) {
    setStatus($("reading-migrate-status"), `สร้างไม่สำเร็จ: ${e.message}`, "err");
    $("reading-migrate-btn").disabled = false;
  }
});

// เชื่อม reading database เดิม
$("reading-link-btn").addEventListener("click", async () => {
  const dbId = extractId($("reading-existing-db").value);
  if (!dbId) return setStatus($("reading-migrate-status"), "ใส่ database id หรือ url", "err");
  setStatus($("reading-migrate-status"), "กำลังเชื่อม…", "busy");
  try {
    const { dataSourceId, parentPageId } = await notion.resolveDataSourceId(token, dbId);
    await setConfig({ readingDatabaseId: dbId, readingDataSourceId: dataSourceId, readingParentPageId: parentPageId });
    setStatus($("reading-migrate-status"), "เชื่อม database สำเร็จ ✓ (ตรวจชื่อ property ให้ตรงกับที่ตั้งไว้ด้วย)", "ok");
    const result = await checkReadingSchema();
    const detail = result?.ready
      ? `เชื่อม database ที่มีอยู่ — schema ตรง v${notion.READING_SCHEMA_VERSION} ครบทุก property`
      : `เชื่อม database ที่มีอยู่ — ขาด property: ${Object.keys(result?.missing || {}).join(", ")} (กดอัปเดตเพื่อเติมให้ครบ)`;
    await writeMigrationLog(
      parentPageId, `เชื่อม อ่านทีหลัง database (v${notion.READING_SCHEMA_VERSION})`,
      notion.READING_SCHEMA_VERSION, detail
    );
  } catch (e) {
    setStatus($("reading-migrate-status"), `เชื่อมไม่ได้: ${e.message}`, "err");
  }
});

// ---------- เช็ค & อัปเดต schema (ปุ่มเดียว: พร้อมแล้ว = disable, ไม่พร้อม = กดอัปเดตได้) ----------

let questMissing = {};
let readingMissing = {};

async function refreshSchemaCheck(dataSourceId, schemaDef, statusEl, btnEl) {
  setStatus(statusEl, "กำลังตรวจสอบ schema…", "busy");
  try {
    const { ready, missing } = await notion.checkSchema(token, dataSourceId, schemaDef);
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
    return { ready, missing };
  } catch (e) {
    setStatus(statusEl, `ตรวจสอบไม่ได้: ${e.message}`, "err");
    return { ready: false, missing: {} };
  }
}

async function checkQuestSchema() {
  const cfg = await getConfig();
  if (!cfg.dataSourceId) { $("quest-schema-check").hidden = true; return null; }
  $("quest-schema-check").hidden = false;
  const result = await refreshSchemaCheck(
    cfg.dataSourceId, notion.questSchema(cfg.propMap), $("quest-schema-status"), $("quest-schema-btn")
  );
  questMissing = result.missing;
  return result;
}

async function checkReadingSchema() {
  const cfg = await getConfig();
  if (!cfg.readingDataSourceId) { $("reading-schema-check").hidden = true; return null; }
  $("reading-schema-check").hidden = false;
  const result = await refreshSchemaCheck(
    cfg.readingDataSourceId, notion.readingSchema(cfg.readingPropMap), $("reading-schema-status"), $("reading-schema-btn")
  );
  readingMissing = result.missing;
  return result;
}

// บันทึก 1 แถวลง migration log (สร้าง database log ครั้งแรกถ้ายังไม่มี) ใต้ page แม่เดียวกับ
// database ที่ migrate — เงียบไว้ถ้าไม่มี parent page ให้สร้าง (เช่น database อยู่ที่ workspace root ตรง ๆ)
// เรียกทุกครั้งที่มี "เหตุการณ์เชื่อมต่อ" (สร้างใหม่ / เชื่อมเดิม / อัปเดต) ไม่ใช่แค่ตอนอัปเดตสำเร็จ
// เพื่อให้เปิด Notion แล้วเรียง "เวอร์ชัน" ดูได้เลยว่า database ไหนอยู่ที่เวอร์ชันอะไร ไม่ต้องเดา
async function writeMigrationLog(parentPageId, eventTitle, version, detail) {
  if (!parentPageId) return;
  const cfg = await getConfig();
  try {
    const { databaseId, dataSourceId } = await notion.ensureMigrationLogDataSource(
      token, parentPageId, cfg.migrationLogDataSourceId
    );
    if (dataSourceId !== cfg.migrationLogDataSourceId) {
      await setConfig({ migrationLogDatabaseId: databaseId, migrationLogDataSourceId: dataSourceId });
    }
    await notion.logMigration(token, dataSourceId, eventTitle, version, detail);
    renderSummary();
  } catch (e) {
    console.warn("[Quest Tasks] log migration failed:", e.message);
  }
}

$("quest-schema-btn").addEventListener("click", async () => {
  const cfg = await getConfig();
  $("quest-schema-btn").disabled = true;
  setStatus($("quest-schema-status"), "กำลังอัปเดต…", "busy");
  try {
    const addedNames = Object.keys(questMissing);
    await notion.updateSchema(token, cfg.dataSourceId, questMissing);
    await writeMigrationLog(
      cfg.questParentPageId, `อัปเดต quest database → v${notion.QUEST_SCHEMA_VERSION}`,
      notion.QUEST_SCHEMA_VERSION, `เพิ่ม property: ${addedNames.join(", ")}`
    );
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
    const addedNames = Object.keys(readingMissing);
    await notion.updateSchema(token, cfg.readingDataSourceId, readingMissing);
    await writeMigrationLog(
      cfg.readingParentPageId, `อัปเดต อ่านทีหลัง database → v${notion.READING_SCHEMA_VERSION}`,
      notion.READING_SCHEMA_VERSION, `เพิ่ม property: ${addedNames.join(", ")}`
    );
    await checkReadingSchema();
  } catch (e) {
    setStatus($("reading-schema-status"), `อัปเดตไม่สำเร็จ: ${e.message}`, "err");
    $("reading-schema-btn").disabled = false;
  }
});

// ---------- STEP 3: settings ----------
$("save-settings").addEventListener("click", async () => {
  const cfg = await getConfig();
  const settings = {
    ...cfg.settings,
    checkIntervalMinutes: Math.max(15, parseInt($("interval").value, 10) || 60),
    autoOpenQuestWindow: $("auto-open").checked,
    quietHours: {
      enabled: $("quiet-enabled").checked,
      start: $("quiet-start").value || "22:00",
      end: $("quiet-end").value || "07:00"
    }
  };
  await setConfig({ settings });
  await chrome.runtime.sendMessage({ action: "rescheduleAlarm" });
  setStatus($("settings-status"), "บันทึกแล้ว ✓", "ok");
});

// ---------- summary / reset ----------
async function renderSummary() {
  const cfg = await getConfig();
  if (!cfg.dataSourceId) { $("summary").hidden = true; return; }
  $("summary").hidden = false;
  $("sum-state").textContent = "พร้อมใช้งาน";
  $("sum-ds").textContent = cfg.dataSourceId;
  $("open-db").onclick = () => {
    if (cfg.databaseId) chrome.tabs.create({ url: `https://www.notion.so/${cfg.databaseId.replace(/-/g, "")}` });
  };
  $("open-log").hidden = !cfg.migrationLogDatabaseId;
  $("open-log").onclick = () => {
    if (cfg.migrationLogDatabaseId) {
      chrome.tabs.create({ url: `https://www.notion.so/${cfg.migrationLogDatabaseId.replace(/-/g, "")}` });
    }
  };
}

$("reset").addEventListener("click", async () => {
  if (!confirm("ล้างการตั้งค่าทั้งหมด? (database ใน Notion จะยังอยู่ ไม่ถูกลบ)")) return;
  await chrome.storage.local.clear();
  location.reload();
});

// ---------- init: เติมค่าเดิม ----------
(async function init() {
  const cfg = await getConfig();
  if (cfg.token) {
    token = cfg.token;
    $("token").value = cfg.token;
    setStatus($("token-status"), "ใช้ token ที่บันทึกไว้", "ok");
    lock("step2", false);
    lock("step3", false);
    lock("step4", false);
    loadPages();
    checkQuestSchema();
    checkReadingSchema();
  }
  if (cfg.readingDataSourceId) {
    setStatus($("reading-migrate-status"), "เชื่อม database อ่านทีหลังไว้แล้ว ✓", "ok");
  }
  $("interval").value = cfg.settings.checkIntervalMinutes;
  $("auto-open").checked = cfg.settings.autoOpenQuestWindow;
  $("quiet-enabled").checked = cfg.settings.quietHours.enabled;
  $("quiet-start").value = cfg.settings.quietHours.start;
  $("quiet-end").value = cfg.settings.quietHours.end;
  renderSummary();
})();
