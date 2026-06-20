// lib/migrate.js — orchestration ของ create/link/check/update schema + เขียน migration log
// ตั้งใจให้ "pure" จริง ๆ: import แค่ notion.js (ก็ใช้ fetch เปล่า ๆ เหมือนกัน) ไม่แตะ chrome.* เลย
// เหตุผล: วันหน้าจะพอร์ตไปรันบน host อื่น (เช่น Scriptable บน iOS) ก็ใช้ไฟล์นี้ + notion.js ซ้ำได้ทันที
// แค่เปลี่ยนตัว "host" (เช่น options.js/migrate.js ของ extension) ที่ทำหน้าที่ 2 อย่าง:
//   1) เก็บ/อ่าน token + id ต่าง ๆ (chrome.storage ฝั่ง extension, Keychain ฝั่ง Scriptable)
//   2) วาด UI (DOM ฝั่ง extension, Alert/UITable ฝั่ง Scriptable)
// ฟังก์ชันในไฟล์นี้รับทุกอย่างที่ต้องใช้ผ่าน param ตรง ๆ ไม่เคยอ่าน config เองสักครั้ง
import * as notion from "./notion.js";

// สร้าง database ใหม่ — schema ครบอยู่แล้วตั้งแต่สร้าง (ready เสมอ)
// createFn: notion.createQuestDatabase หรือ notion.createReadingDatabase (เซ็นเหมือนกันทั้งคู่)
export async function createDatabase({ token, parentPageId, propMap, createFn, schemaVersion, title }) {
  const { databaseId, dataSourceId } = await createFn(token, parentPageId, propMap);
  return {
    databaseId, dataSourceId, parentPageId, ready: true, missing: {},
    log: {
      eventTitle: `สร้าง ${title} database ใหม่ (v${schemaVersion})`,
      version: schemaVersion,
      detail: "สร้างใหม่ — schema ครบทุก property ตั้งแต่สร้าง"
    }
  };
}

// เชื่อม database เดิม + เช็ค schema ทันที (ผลเช็คใส่ใน log ด้วยเลย ไม่ว่า ready หรือไม่)
export async function linkDatabase({ token, databaseId, schemaDef, schemaVersion, title }) {
  const { dataSourceId, parentPageId } = await notion.resolveDataSourceId(token, databaseId);
  const { ready, missing } = await notion.checkSchema(token, dataSourceId, schemaDef);
  const detail = ready
    ? `เชื่อม database ที่มีอยู่ — schema ตรง v${schemaVersion} ครบทุก property`
    : `เชื่อม database ที่มีอยู่ — ขาด property: ${Object.keys(missing).join(", ")} (กดอัปเดตเพื่อเติมให้ครบ)`;
  return {
    databaseId, dataSourceId, parentPageId, ready, missing,
    log: { eventTitle: `เชื่อม ${title} database (v${schemaVersion})`, version: schemaVersion, detail }
  };
}

// เช็ค schema เฉย ๆ ไม่ log — ใช้ตอนเปิดหน้า/refresh ซ้ำ (อย่า spam log ทุกครั้งที่เปิดหน้า)
export async function checkDatabase({ token, dataSourceId, schemaDef }) {
  return notion.checkSchema(token, dataSourceId, schemaDef);
}

// อัปเดต property ที่ขาดเข้า database จริง — คืน log ให้ host ไปเขียนต่อ
export async function updateDatabase({ token, dataSourceId, missing, schemaVersion, title }) {
  await notion.updateSchema(token, dataSourceId, missing);
  const addedNames = Object.keys(missing);
  return {
    log: {
      eventTitle: `อัปเดต ${title} database → v${schemaVersion}`,
      version: schemaVersion,
      detail: `เพิ่ม property: ${addedNames.join(", ")}`
    }
  };
}

// เขียน log ลง Notion — สร้าง "🛠 Migration Log" database ครั้งแรกถ้ายังไม่มี (idempotent ผ่าน
// existingLogDataSourceId ที่ host ส่งมาจาก storage ของตัวเอง) เงียบไว้ถ้าไม่มี parentPageId
export async function writeLog({ token, parentPageId, existingLogDataSourceId, log }) {
  if (!parentPageId) return { logDatabaseId: null, logDataSourceId: existingLogDataSourceId };
  const { databaseId, dataSourceId } = await notion.ensureMigrationLogDataSource(
    token, parentPageId, existingLogDataSourceId
  );
  await notion.logMigration(token, dataSourceId, log.eventTitle, log.version, log.detail);
  return { logDatabaseId: databaseId || null, logDataSourceId: dataSourceId };
}
