// lib/storage.js
// แหล่งเก็บ config และ state ทั้งหมดของ extension (chrome.storage.local)
// ทุกไฟล์ที่ต้องอ่าน/เขียน config ให้ผ่านที่นี่ที่เดียว เพื่อกัน key กระจัดกระจาย

const DEFAULTS = {
  // --- การเชื่อมต่อ Notion ---
  token: null,            // Internal Integration token (เก็บแบบ local เท่านั้น)
  databaseId: null,       // id ของ database container
  dataSourceId: null,     // id ของ data source ที่ใช้ query/create จริง (API 2025-09-03+)
  questParentPageId: null, // page แม่ของ quest database — ใช้สร้าง migration log ใต้ page เดียวกัน

  // --- การจับคู่ชื่อ property ---
  // ถ้าผู้ใช้ rename column ใน Notion ให้แก้ตรงนี้ ไม่ต้องไปแก้โค้ดที่อื่น
  propMap: {
    title: "งาน",
    date: "วันเตือน",
    done: "เสร็จแล้ว",
    rank: "ระดับ"
  },

  // --- "อ่านทีหลัง" (เมนูแยกจาก quest, database คนละตัว) ---
  readingDatabaseId: null,
  readingDataSourceId: null,
  readingParentPageId: null, // page แม่ของ reading database
  readingPropMap: {
    title: "ชื่อเรื่อง",
    url: "ลิงก์",
    tag: "แท็ก",
    done: "อ่านแล้ว",
    note: "บันทึก"
  },

  // --- migration log (audit trail บน Notion เอง) — สร้างใต้ page แม่ของ database แรกที่ migrate ---
  migrationLogDatabaseId: null,
  migrationLogDataSourceId: null,

  // --- การตั้งค่าการเตือน ---
  settings: {
    checkIntervalMinutes: 15,   // ความถี่ที่ service worker เช็คงานค้าง (ขั้นต่ำของ chrome.alarms = 15)
    timezone: "Asia/Bangkok",
    autoOpenQuestWindow: true,   // เด้งหน้าต่าง quest อัตโนมัติเมื่อมีงานถึงกำหนด
    quietHours: {
      enabled: true,
      start: "22:00",            // ช่วงห้ามเด้ง popup (ยังขึ้น badge ปกติ)
      end: "07:00"
    }
  },

  // --- สถานะเกม (gamification) ---
  game: {
    xp: 0,
    level: 1,
    streak: 0,
    lastClearedDate: null        // วันล่าสุดที่เคลียร์งานครบ (YYYY-MM-DD)
  },

  // --- สถานะภายใน ---
  // กัน quest window เด้งซ้ำ: จำ id งานที่เด้งไปแล้วของวันนี้ (reset เมื่อขึ้นวันใหม่)
  shownQuestState: { date: null, ids: [] },

  // cache ผลเช็คเวอร์ชันล่าสุดจาก GitHub: { latest, checkedAt } (กัน fetch ถี่เกิน)
  updateCheck: null
};

export async function getConfig() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  // merge แบบ deep ทีละชั้นเพื่อให้ key ใหม่ที่เพิ่มในอนาคตมี default เสมอ
  return {
    ...DEFAULTS,
    ...stored,
    propMap: { ...DEFAULTS.propMap, ...(stored.propMap || {}) },
    readingPropMap: { ...DEFAULTS.readingPropMap, ...(stored.readingPropMap || {}) },
    settings: {
      ...DEFAULTS.settings,
      ...(stored.settings || {}),
      quietHours: { ...DEFAULTS.settings.quietHours, ...((stored.settings || {}).quietHours || {}) }
    },
    game: { ...DEFAULTS.game, ...(stored.game || {}) }
  };
}

export async function setConfig(patch) {
  await chrome.storage.local.set(patch);
}

export async function isSetupComplete() {
  const cfg = await getConfig();
  return Boolean(cfg.token && cfg.dataSourceId);
}

export async function isReadingSetupComplete() {
  const cfg = await getConfig();
  return Boolean(cfg.token && cfg.readingDataSourceId);
}

// --- ตรรกะเกม ---

// ตัวอักษรระดับ (S/A/B/C) จากค่า rank เต็ม เช่น "B - ปกติ" -> "B"; ว่าง -> "B"
export function rankLetter(rankValue) {
  return (rankValue || "B").trim().charAt(0).toUpperCase();
}

// XP ที่ได้ต่อ quest ตามระดับ (rank prefix: S/A/B/C)
export function xpForRank(rankValue) {
  return ({ S: 40, A: 25, B: 15, C: 10 })[rankLetter(rankValue)] ?? 15;
}

// เลเวลคิดแบบ XP สะสมง่าย ๆ: ต้องใช้ level*100 XP ต่อเลเวล
export function levelFromXp(xp) {
  let level = 1;
  let need = 100;
  let remaining = xp;
  while (remaining >= need) {
    remaining -= need;
    level += 1;
    need = level * 100;
  }
  return { level, intoLevel: remaining, needForNext: need };
}

// เรียกตอนเคลียร์ quest สำเร็จ -> คืน state เกมใหม่ + จำนวน XP ที่เพิ่ง earn
export async function applyReward(rankValue, todayISO) {
  const cfg = await getConfig();
  const gained = xpForRank(rankValue);
  const newXp = cfg.game.xp + gained;
  const { level } = levelFromXp(newXp);
  const leveledUp = level > cfg.game.level;

  const game = { ...cfg.game, xp: newXp, level };
  await setConfig({ game });
  return { gained, leveledUp, game };
}

// เรียกเมื่อ "เคลียร์งานครบทั้งหมดของวัน" -> อัปเดต streak
export async function updateStreakIfCleared(todayISO, remainingCount) {
  if (remainingCount > 0) return null;
  const cfg = await getConfig();
  if (cfg.game.lastClearedDate === todayISO) return cfg.game; // วันนี้นับไปแล้ว

  const yesterday = shiftISO(todayISO, -1);
  const continued = cfg.game.lastClearedDate === yesterday;
  const streak = continued ? cfg.game.streak + 1 : 1;

  const game = { ...cfg.game, streak, lastClearedDate: todayISO };
  await setConfig({ game });
  return game;
}

function shiftISO(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
