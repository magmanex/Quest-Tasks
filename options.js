// options.js — หน้าตั้งค่า + flow migrate ครั้งแรก
// หน้านี้เป็น extension page จึงเรียก notion.js ตรงได้ (ไม่ติด CORS)
import * as notion from "./lib/notion.js";
import { getConfig, setConfig } from "./lib/storage.js";

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
    loadPages();
  } catch (e) {
    setStatus($("token-status"), `ล้มเหลว: ${e.message}`, "err");
  }
});

// ---------- STEP 2: สลับโหมด ----------
document.querySelectorAll(".seg-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const mode = btn.dataset.mode;
    $("mode-new").hidden = mode !== "new";
    $("mode-existing").hidden = mode !== "existing";
  });
});

// โหลด page ที่เข้าถึงได้
async function loadPages() {
  if (!token) return;
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
$("parent-select").addEventListener("change", (e) => {
  $("migrate-btn").disabled = !e.target.value;
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
    const { databaseId, dataSourceId } = await notion.createQuestDatabase(token, parentId, cfg.propMap);
    await setConfig({ databaseId, dataSourceId });
    setStatus($("migrate-status"), "สร้าง database สำเร็จ 🎉", "ok");
    await chrome.runtime.sendMessage({ action: "rescheduleAlarm" });
    await chrome.runtime.sendMessage({ action: "refreshBadge" });
    renderSummary();
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
    const dataSourceId = await notion.resolveDataSourceId(token, dbId);
    await setConfig({ databaseId: dbId, dataSourceId });
    setStatus($("migrate-status"), "เชื่อม database สำเร็จ ✓ (ตรวจชื่อ property ให้ตรงกับที่ตั้งไว้ด้วย)", "ok");
    await chrome.runtime.sendMessage({ action: "rescheduleAlarm" });
    await chrome.runtime.sendMessage({ action: "refreshBadge" });
    renderSummary();
  } catch (e) {
    setStatus($("migrate-status"), `เชื่อมไม่ได้: ${e.message}`, "err");
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
    loadPages();
  }
  $("interval").value = cfg.settings.checkIntervalMinutes;
  $("auto-open").checked = cfg.settings.autoOpenQuestWindow;
  $("quiet-enabled").checked = cfg.settings.quietHours.enabled;
  $("quiet-start").value = cfg.settings.quietHours.start;
  $("quiet-end").value = cfg.settings.quietHours.end;
  renderSummary();
})();
