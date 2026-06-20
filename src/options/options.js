// options.js — หน้าตั้งค่า: token + การเตือน + ล้างการตั้งค่า
// การจัดการ quest/reading database (สร้าง/เชื่อม/เช็ค schema/migration log) ย้ายไป src/migrate/ แล้ว
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

// ---------- STEP 1: ทดสอบ token ----------
$("test-btn").addEventListener("click", async () => {
  const t = $("token").value.trim();
  if (!t) return setStatus($("token-status"), "ใส่ token ก่อน", "err");
  setStatus($("token-status"), "กำลังตรวจสอบ…", "busy");
  try {
    const me = await notion.whoAmI(t);
    await setConfig({ token: t });
    setStatus($("token-status"), `เชื่อมต่อสำเร็จ: ${me.name || me.bot?.owner?.type || "integration"}`, "ok");
    lock("step3", false);
    $("migrate-nav").hidden = false;
  } catch (e) {
    setStatus($("token-status"), `ล้มเหลว: ${e.message}`, "err");
  }
});

// ---------- STEP 2: settings ----------
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

// ---------- ล้างการตั้งค่า ----------
$("reset").addEventListener("click", async () => {
  if (!confirm("ล้างการตั้งค่าทั้งหมด? (database ใน Notion จะยังอยู่ ไม่ถูกลบ)")) return;
  await chrome.storage.local.clear();
  location.reload();
});

// ---------- init: เติมค่าเดิม ----------
(async function init() {
  const cfg = await getConfig();
  if (cfg.token) {
    $("token").value = cfg.token;
    setStatus($("token-status"), "ใช้ token ที่บันทึกไว้", "ok");
    lock("step3", false);
    $("migrate-nav").hidden = false;
  }
  $("interval").value = cfg.settings.checkIntervalMinutes;
  $("auto-open").checked = cfg.settings.autoOpenQuestWindow;
  $("quiet-enabled").checked = cfg.settings.quietHours.enabled;
  $("quiet-start").value = cfg.settings.quietHours.start;
  $("quiet-end").value = cfg.settings.quietHours.end;
})();
