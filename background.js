// background.js — service worker (MV3)
// หน้าที่: ตั้ง alarm เช็คงานเป็นระยะ, อัปเดต badge, เด้งหน้าต่าง quest,
//          จัดการ context menu, และเป็น message API กลางให้ popup/quest เรียกใช้
//
// ทำไม Notion call ต้องผ่าน background: รวมการอัปเดต badge + game state ไว้ที่เดียว
// (popup/options เรียก notion.js ตรงก็ได้ แต่ action สำคัญเรา route ผ่านนี่เพื่อความ consistent)

import * as notion from "./lib/notion.js";
import { getConfig, setConfig, isSetupComplete, applyReward, updateStreakIfCleared } from "./lib/storage.js";
import { bangkokToday, addDays } from "./lib/thaiDate.js";

const ALARM_NAME = "questCheck";
let questWindowId = null;

// ---------- lifecycle ----------

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  chrome.contextMenus.create({
    id: "addQuestFromSelection",
    title: 'เพิ่มเป็น quest: "%s"',
    contexts: ["selection"]
  });
  refreshBadge();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  refreshBadge();
});

async function ensureAlarm() {
  const cfg = await getConfig();
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: Math.max(15, cfg.settings.checkIntervalMinutes)
  });
}

// ---------- alarm: เช็คงานค้าง ----------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  await runDueCheck();
});

async function runDueCheck() {
  if (!(await isSetupComplete())) return;
  const tasks = await safeQueryDue();
  if (tasks === null) return; // error แล้ว (เช่น token หมดอายุ) — เงียบไว้ ไม่รบกวน

  updateBadge(tasks.length);

  if (tasks.length === 0) return;

  const cfg = await getConfig();
  if (!cfg.settings.autoOpenQuestWindow) return;
  if (isQuietNow(cfg.settings.quietHours)) return;

  const today = bangkokToday();
  if (cfg.lastQuestShownDate === today) return; // เด้งไปแล้ววันนี้ ไม่กวนซ้ำ

  await setConfig({ lastQuestShownDate: today });
  openQuestWindow();
}

// ---------- badge ----------

async function refreshBadge() {
  if (!(await isSetupComplete())) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }
  const tasks = await safeQueryDue();
  updateBadge(tasks ? tasks.length : 0);
}

function updateBadge(count) {
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#E0A106" });
}

// ---------- quest window ----------

function openQuestWindow() {
  if (questWindowId !== null) {
    chrome.windows.update(questWindowId, { focused: true }).catch(() => {
      questWindowId = null;
      createQuestWindow();
    });
    return;
  }
  createQuestWindow();
}

function createQuestWindow() {
  chrome.windows.create(
    { url: "quest.html", type: "popup", width: 440, height: 640 },
    (win) => { questWindowId = win.id; }
  );
}

chrome.windows.onRemoved.addListener((id) => {
  if (id === questWindowId) questWindowId = null;
});

// ---------- context menu ----------

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "addQuestFromSelection" || !info.selectionText) return;
  if (!(await isSetupComplete())) {
    notify("ยังไม่ได้ตั้งค่า", "เปิดหน้าตั้งค่าของ extension ก่อนนะ");
    return;
  }
  const cfg = await getConfig();
  try {
    await notion.createTask(cfg.token, cfg.dataSourceId, cfg.propMap, {
      title: info.selectionText.trim().slice(0, 200),
      dateISO: bangkokToday(),
      rank: "B - ปกติ"
    });
    notify("เพิ่ม quest แล้ว", info.selectionText.trim().slice(0, 60));
    refreshBadge();
  } catch (e) {
    notify("เพิ่มไม่สำเร็จ", e.message);
  }
});

// ---------- message API (เรียกจาก popup / quest) ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch((e) => {
    sendResponse({ ok: false, error: e.message });
  });
  return true; // ตอบแบบ async — ต้อง return true เสมอ
});

async function handleMessage(msg) {
  const cfg = await getConfig();
  const today = bangkokToday();

  switch (msg.action) {
    case "status":
      return { ok: true, setup: Boolean(cfg.token && cfg.dataSourceId), game: cfg.game };

    case "queryDue": {
      const tasks = await notion.getDueTasks(cfg.token, cfg.dataSourceId, cfg.propMap, today);
      updateBadge(tasks.length);
      return { ok: true, tasks, game: cfg.game };
    }

    case "queryUpcoming": {
      const toISO = addDays(today, msg.days || 3);
      const tasks = await notion.getUpcomingTasks(cfg.token, cfg.dataSourceId, cfg.propMap, today, toISO);
      return { ok: true, tasks };
    }

    case "add": {
      const task = await notion.createTask(cfg.token, cfg.dataSourceId, cfg.propMap, {
        title: msg.title, dateISO: msg.dateISO, rank: msg.rank
      });
      refreshBadge();
      return { ok: true, task };
    }

    case "complete": {
      await notion.completeTask(cfg.token, msg.pageId, cfg.propMap);
      const reward = await applyReward(msg.rank, today);
      const tasks = await notion.getDueTasks(cfg.token, cfg.dataSourceId, cfg.propMap, today);
      updateBadge(tasks.length);
      const streakGame = await updateStreakIfCleared(today, tasks.length);
      return { ok: true, reward, remaining: tasks.length, game: streakGame || reward.game };
    }

    case "snooze": {
      const newDate = addDays(today, msg.days || 1);
      await notion.snoozeTask(cfg.token, msg.pageId, cfg.propMap, newDate);
      const tasks = await notion.getDueTasks(cfg.token, cfg.dataSourceId, cfg.propMap, today);
      updateBadge(tasks.length);
      return { ok: true, remaining: tasks.length };
    }

    case "rescheduleAlarm":
      await ensureAlarm();
      return { ok: true };

    case "refreshBadge":
      await refreshBadge();
      return { ok: true };

    default:
      return { ok: false, error: `ไม่รู้จัก action: ${msg.action}` };
  }
}

// ---------- helpers ----------

async function safeQueryDue() {
  try {
    const cfg = await getConfig();
    return await notion.getDueTasks(cfg.token, cfg.dataSourceId, cfg.propMap, bangkokToday());
  } catch (e) {
    console.warn("[Quest Tasks] query due failed:", e.message);
    return null;
  }
}

// คืน true ถ้าตอนนี้อยู่ในช่วง quiet hours (รองรับช่วงข้ามเที่ยงคืน)
function isQuietNow(q) {
  if (!q?.enabled) return false;
  const now = new Date().toLocaleTimeString("en-GB", {
    timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hour12: false
  });
  const [s, e, n] = [q.start, q.end, now];
  return s <= e ? (n >= s && n < e) : (n >= s || n < e);
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon48.png",
    title,
    message: message || ""
  });
}
