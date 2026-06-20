// lib/notion.js
// ตัวห่อ Notion REST API ทั้งหมดอยู่ที่นี่ที่เดียว
// ใช้ API version 2025-09-03 ซึ่งแยก database (container) ออกจาก data source
//   - query / create page : อ้างอิงด้วย data_source_id (ไม่ใช่ database_id)
//   - ดูรายละเอียด breaking change: https://developers.notion.com/docs/upgrade-guide-2025-09-03
//
// หมายเหตุ CORS: ฟังก์ชันเหล่านี้ต้องถูกเรียกจาก service worker หรือ extension page
// (popup/options) เท่านั้น — ห้ามเรียกจาก content script เพราะจะติด CORS

const NOTION_VERSION = "2025-09-03";
const BASE = "https://api.notion.com/v1";

function headers(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json"
  };
}

async function call(token, path, method = "GET", body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(token),
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || `${res.status} ${res.statusText}`;
    throw new NotionError(msg, res.status, data?.code);
  }
  return data;
}

export class NotionError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "NotionError";
    this.status = status;
    this.code = code;
  }
}

// ตรวจ token + คืนข้อมูล bot user (ใช้ในหน้า settings เพื่อ "ทดสอบการเชื่อมต่อ")
export async function whoAmI(token) {
  return call(token, "/users/me");
}

// ค้นหา page ที่ integration เข้าถึงได้ (ใช้เลือกเป็น parent ตอนสร้าง database)
// API 2025-09-03: filter value เป็น "page" | "data_source" (ไม่ใช่ "database" แล้ว)
export async function listAccessiblePages(token) {
  const data = await call(token, "/search", "POST", {
    filter: { property: "object", value: "page" },
    page_size: 50
  });
  return (data.results || []).map(p => ({
    id: p.id,
    title: extractTitle(p) || "(ไม่มีชื่อ)",
    url: p.url
  }));
}

// เลขเวอร์ชัน schema — bump ทุกครั้งที่แก้ questSchema()/readingSchema() (เพิ่ม/ลบ/เปลี่ยน type property)
// เขียนลง "เวอร์ชัน" ใน migration log ทุกครั้งที่ create/link/update เพื่อให้ดูใน Notion ได้ว่า
// database ไหนอยู่ที่เวอร์ชันล่าสุดหรือยัง โดยไม่ต้องเปิดโค้ดมาไล่เทียบ property เอง
export const QUEST_SCHEMA_VERSION = 1;
export const READING_SCHEMA_VERSION = 1;

// วันที่ "ออก" แต่ละเวอร์ชัน (วันที่ codebase เปลี่ยน schema จริง ๆ ไม่ใช่วันที่ user สั่ง migrate)
// เพิ่ม entry ใหม่ทุกครั้งที่ bump เลขเวอร์ชันด้านบน — ใช้โชว์ใน migration log คู่กับ "วันที่อัปเดต"
// (วันที่ user สั่ง migrate จริง) จะได้แยกออกว่า "เวอร์ชันนี้ออกเมื่อไหร่" vs "database นี้ตามทันเมื่อไหร่"
export const QUEST_SCHEMA_RELEASES = { 1: "2026-06-21" };
export const READING_SCHEMA_RELEASES = { 1: "2026-06-21" };

// schema ของ quest/reading เป็น single source of truth — ใช้ทั้งตอนสร้าง database ใหม่
// และตอนเช็ค (checkSchema) ว่า database ที่เชื่อมไว้ขาด property ไหนไปจากที่โค้ดต้องใช้
export function questSchema(propMap) {
  return {
    [propMap.title]: { title: {} },
    [propMap.date]: { date: {} },
    [propMap.done]: { checkbox: {} },
    [propMap.rank]: {
      select: {
        options: [
          { name: "S - ด่วนมาก", color: "red" },
          { name: "A - สำคัญ", color: "orange" },
          { name: "B - ปกติ", color: "blue" },
          { name: "C - ทำเมื่อว่าง", color: "gray" }
        ]
      }
    }
  };
}

export function readingSchema(propMap) {
  return {
    [propMap.title]: { title: {} },
    [propMap.url]: { url: {} },
    [propMap.tag]: { multi_select: {} },
    [propMap.done]: { checkbox: {} },
    [propMap.note]: { rich_text: {} }
  };
}

// สร้าง database ใหม่เป็น subpage ใต้ parentPageId พร้อม schema สำหรับ quest
// API 2025-09-03: properties ต้องห่อใน initial_data_source
export async function createQuestDatabase(token, parentPageId, propMap) {
  const data = await call(token, "/databases", "POST", {
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: "🎯 Quest Tasks" } }],
    initial_data_source: { properties: questSchema(propMap) }
  });
  const dataSourceId = data?.data_sources?.[0]?.id;
  if (!dataSourceId) {
    throw new NotionError("สร้าง database แล้วแต่หา data_source_id ไม่เจอ", 500);
  }
  return { databaseId: data.id, dataSourceId, parentPageId };
}

// resolve data_source_id จาก database_id (กรณีผู้ใช้เลือกใช้ database เดิมที่มีอยู่)
// คืน parentPageId ด้วย (ถ้า parent เป็น page) — ใช้สร้าง migration log ใต้ page เดียวกันได้ทีหลัง
export async function resolveDataSourceId(token, databaseId) {
  const data = await call(token, `/databases/${databaseId}`);
  const id = data?.data_sources?.[0]?.id;
  if (!id) throw new NotionError("database นี้ไม่มี data source", 400);
  const parentPageId = data.parent?.type === "page_id" ? data.parent.page_id : null;
  return { dataSourceId: id, parentPageId };
}

// สร้าง database ใหม่เป็น subpage ใต้ parentPageId สำหรับเก็บ "อ่านทีหลัง"
// แท็กเป็น multi_select (เผื่อใส่ได้หลายแท็ก) และมี rich_text สำหรับจดบันทึกสั้น ๆ
// ไม่มี date property — เรียงตาม created_time (built-in timestamp ของ Notion) แทน
export async function createReadingDatabase(token, parentPageId, propMap) {
  const data = await call(token, "/databases", "POST", {
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: "📚 อ่านทีหลัง" } }],
    initial_data_source: { properties: readingSchema(propMap) }
  });
  const dataSourceId = data?.data_sources?.[0]?.id;
  if (!dataSourceId) {
    throw new NotionError("สร้าง database แล้วแต่หา data_source_id ไม่เจอ", 500);
  }
  return { databaseId: data.id, dataSourceId, parentPageId };
}

// เช็คว่า data source มี property ครบตาม schema ที่โค้ดต้องใช้ไหม (ชื่อ + type ต้องตรง)
// ไม่เช็ค options ของ select/multi_select เพราะ Notion auto-เพิ่ม option ใหม่เองตอน write อยู่แล้ว
export async function checkSchema(token, dataSourceId, schemaDef) {
  const data = await call(token, `/data_sources/${dataSourceId}`);
  const actual = data.properties || {};
  const missing = {};
  for (const [name, def] of Object.entries(schemaDef)) {
    const wantType = Object.keys(def)[0];
    if (!actual[name] || actual[name].type !== wantType) missing[name] = def;
  }
  return { ready: Object.keys(missing).length === 0, missing };
}

// เพิ่ม property ที่ขาดเข้า data source (PATCH แบบ merge — ไม่แตะ property เดิมที่ไม่ได้ส่งไป)
export async function updateSchema(token, dataSourceId, missing) {
  if (!missing || Object.keys(missing).length === 0) return null;
  return call(token, `/data_sources/${dataSourceId}`, "PATCH", { properties: missing });
}

// database สำหรับบันทึก migration log — สร้างครั้งแรกครั้งเดียว (idempotent ผ่าน existingDataSourceId)
// มี property "เวอร์ชัน" เป็น number ตั้งใจให้ sort/filter ใน Notion ได้ — เปิด database นี้แล้วเรียง
// "เวอร์ชัน" จากมากไปน้อย แถวบนสุด = เวอร์ชันล่าสุดที่ database นั้นอยู่ ไม่ต้องไล่อ่านโค้ดเทียบเอง
export async function ensureMigrationLogDataSource(token, parentPageId, existingDataSourceId) {
  if (existingDataSourceId) return { databaseId: null, dataSourceId: existingDataSourceId };
  const data = await call(token, "/databases", "POST", {
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: "🛠 Migration Log" } }],
    initial_data_source: {
      properties: {
        "เหตุการณ์": { title: {} },
        "เวอร์ชัน": { number: {} },
        "วันที่อัปเดต": { date: {} },        // วันที่ user สั่ง migrate จริง (ไม่ใช่ created_time ดิบ
                                            // — ใส่เป็น property จะ sort/filter ใน Notion ได้ตรงกว่า)
        "วันที่ออกเวอร์ชัน": { date: {} },   // วันที่ codebase เปลี่ยน schema เวอร์ชันนี้ (ดู *_SCHEMA_RELEASES)
        "รายละเอียด": { rich_text: {} }
      }
    }
  });
  const dataSourceId = data?.data_sources?.[0]?.id;
  if (!dataSourceId) {
    throw new NotionError("สร้าง migration log แล้วแต่หา data_source_id ไม่เจอ", 500);
  }
  return { databaseId: data.id, dataSourceId };
}

// ดึง log ทั้งหมด เรียงใหม่สุดก่อน — ใช้แสดงประวัติ migrate ในหน้า migrate.html
export async function getMigrationLog(token, logDataSourceId) {
  const data = await call(token, `/data_sources/${logDataSourceId}/query`, "POST", {
    sorts: [{ timestamp: "created_time", direction: "descending" }]
  });
  return (data.results || []).map(page => {
    const props = page.properties || {};
    return {
      id: page.id,
      eventTitle: props["เหตุการณ์"]?.title?.map(t => t.plain_text).join("") || "",
      version: props["เวอร์ชัน"]?.number ?? null,
      updatedDate: props["วันที่อัปเดต"]?.date?.start || null,
      releaseDate: props["วันที่ออกเวอร์ชัน"]?.date?.start || null,
      detail: props["รายละเอียด"]?.rich_text?.map(t => t.plain_text).join("") || "",
      createdTime: page.created_time
    };
  });
}

export async function logMigration(token, logDataSourceId, { eventTitle, version, updatedDate, releaseDate, detail }) {
  const properties = {
    "เหตุการณ์": { title: [{ text: { content: eventTitle } }] },
    "เวอร์ชัน": { number: version },
    "รายละเอียด": { rich_text: [{ text: { content: detail } }] }
  };
  if (updatedDate) properties["วันที่อัปเดต"] = { date: { start: updatedDate } };
  if (releaseDate) properties["วันที่ออกเวอร์ชัน"] = { date: { start: releaseDate } };
  return call(token, "/pages", "POST", {
    parent: { type: "data_source_id", data_source_id: logDataSourceId },
    properties
  });
}

// เพิ่มเรื่องที่จะอ่านทีหลัง
export async function createReadingItem(token, dataSourceId, propMap, { title, url, tag }) {
  const properties = {
    [propMap.title]: { title: [{ text: { content: title } }] },
    [propMap.done]: { checkbox: false }
  };
  if (url) properties[propMap.url] = { url };
  if (tag) properties[propMap.tag] = { multi_select: [{ name: tag }] };

  const page = await call(token, "/pages", "POST", {
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    properties
  });
  return normalizeReadingItem(page, propMap);
}

// ดึงรายการที่ยังไม่อ่าน เรียงใหม่สุดก่อน (created_time)
export async function getUnreadItems(token, dataSourceId, propMap) {
  const data = await call(token, `/data_sources/${dataSourceId}/query`, "POST", {
    filter: { property: propMap.done, checkbox: { equals: false } },
    sorts: [{ timestamp: "created_time", direction: "descending" }]
  });
  return (data.results || []).map(page => normalizeReadingItem(page, propMap));
}

// mark ว่าอ่านแล้ว
export async function markReadItem(token, pageId, propMap) {
  return call(token, `/pages/${pageId}`, "PATCH", {
    properties: { [propMap.done]: { checkbox: true } }
  });
}

// archive ออกจาก database (ลบแบบ soft — กู้คืนได้ใน Notion trash)
export async function archiveReadingItem(token, pageId) {
  return call(token, `/pages/${pageId}`, "PATCH", { archived: true });
}

// ดึงงานที่ถึงกำหนด: วันเตือน <= วันนี้ และยังไม่เสร็จ
export async function getDueTasks(token, dataSourceId, propMap, todayISO) {
  const data = await call(token, `/data_sources/${dataSourceId}/query`, "POST", {
    filter: {
      and: [
        { property: propMap.date, date: { on_or_before: todayISO } },
        { property: propMap.done, checkbox: { equals: false } }
      ]
    },
    sorts: [{ property: propMap.date, direction: "ascending" }]
  });
  return (data.results || []).map(page => normalizeTask(page, propMap));
}

// ดึงงานล่วงหน้า: วันเตือนอยู่ในช่วง (afterISO, toISO] และยังไม่เสร็จ
// after = หลังจากวันนี้ (exclusive) จึงไม่ทับกับ getDueTasks ที่เอางานถึงกำหนดวันนี้ไปแล้ว
export async function getUpcomingTasks(token, dataSourceId, propMap, afterISO, toISO) {
  const data = await call(token, `/data_sources/${dataSourceId}/query`, "POST", {
    filter: {
      and: [
        { property: propMap.date, date: { after: afterISO } },
        { property: propMap.date, date: { on_or_before: toISO } },
        { property: propMap.done, checkbox: { equals: false } }
      ]
    },
    sorts: [{ property: propMap.date, direction: "ascending" }]
  });
  return (data.results || []).map(page => normalizeTask(page, propMap));
}

// สร้าง quest ใหม่
export async function createTask(token, dataSourceId, propMap, { title, dateISO, rank }) {
  const properties = {
    [propMap.title]: { title: [{ text: { content: title } }] },
    [propMap.date]: { date: { start: dateISO } },
    [propMap.done]: { checkbox: false }
  };
  if (rank) properties[propMap.rank] = { select: { name: rank } };

  const page = await call(token, "/pages", "POST", {
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    properties
  });
  return normalizeTask(page, propMap);
}

// mark ว่าเสร็จ
export async function completeTask(token, pageId, propMap) {
  return call(token, `/pages/${pageId}`, "PATCH", {
    properties: { [propMap.done]: { checkbox: true } }
  });
}

// เลื่อนวันเตือน (snooze)
export async function snoozeTask(token, pageId, propMap, newDateISO) {
  return call(token, `/pages/${pageId}`, "PATCH", {
    properties: { [propMap.date]: { date: { start: newDateISO } } }
  });
}

// --- helpers ---

function normalizeTask(page, propMap) {
  const props = page.properties || {};
  const titleProp = props[propMap.title];
  const dateProp = props[propMap.date];
  const rankProp = props[propMap.rank];
  return {
    id: page.id,
    title: titleProp?.title?.map(t => t.plain_text).join("") || "(ไม่มีชื่อ)",
    date: dateProp?.date?.start || null,
    rank: rankProp?.select?.name || null,
    url: page.url
  };
}

function normalizeReadingItem(page, propMap) {
  const props = page.properties || {};
  const titleProp = props[propMap.title];
  const urlProp = props[propMap.url];
  const tagProp = props[propMap.tag];
  const doneProp = props[propMap.done];
  return {
    id: page.id,
    title: titleProp?.title?.map(t => t.plain_text).join("") || "(ไม่มีชื่อ)",
    url: urlProp?.url || null,
    tags: (tagProp?.multi_select || []).map(t => t.name),
    done: doneProp?.checkbox || false,
    createdTime: page.created_time,
    notionUrl: page.url
  };
}

function extractTitle(page) {
  const props = page.properties || {};
  for (const key of Object.keys(props)) {
    if (props[key]?.type === "title") {
      return props[key].title?.map(t => t.plain_text).join("");
    }
  }
  return null;
}
