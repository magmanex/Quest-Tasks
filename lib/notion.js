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

// สร้าง database ใหม่เป็น subpage ใต้ parentPageId พร้อม schema สำหรับ quest
// API 2025-09-03: properties ต้องห่อใน initial_data_source
export async function createQuestDatabase(token, parentPageId, propMap) {
  const data = await call(token, "/databases", "POST", {
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: "🎯 Quest Tasks" } }],
    initial_data_source: {
      properties: {
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
      }
    }
  });
  const dataSourceId = data?.data_sources?.[0]?.id;
  if (!dataSourceId) {
    throw new NotionError("สร้าง database แล้วแต่หา data_source_id ไม่เจอ", 500);
  }
  return { databaseId: data.id, dataSourceId };
}

// resolve data_source_id จาก database_id (กรณีผู้ใช้เลือกใช้ database เดิมที่มีอยู่)
export async function resolveDataSourceId(token, databaseId) {
  const data = await call(token, `/databases/${databaseId}`);
  const id = data?.data_sources?.[0]?.id;
  if (!id) throw new NotionError("database นี้ไม่มี data source", 400);
  return id;
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

function extractTitle(page) {
  const props = page.properties || {};
  for (const key of Object.keys(props)) {
    if (props[key]?.type === "title") {
      return props[key].title?.map(t => t.plain_text).join("");
    }
  }
  return null;
}
