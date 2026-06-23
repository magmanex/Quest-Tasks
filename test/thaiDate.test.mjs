// node test/thaiDate.test.mjs  — assert-based, no framework
import assert from "node:assert";
import { parseQuickAdd, nextOccurrence, addMonths } from "../src/lib/thaiDate.js";

const base = "2026-06-16";
const p = (s) => parseQuickAdd(s, base);

// เวลาแยกออกจากชื่อ ไปอยู่ใน dateISO (เคสหลักที่ผู้ใช้รายงาน)
assert.deepEqual(p("ออกไปกินข้าว 16/6/26 12.00"),
  { title: "ออกไปกินข้าว", dateISO: "2026-06-16T12:00:00+07:00", repeat: null });

// เวลาอย่างเดียว ไม่มีวัน -> วันนี้ + เวลา
assert.deepEqual(p("ออกไปกินข้าว 12.00"),
  { title: "ออกไปกินข้าว", dateISO: "2026-06-16T12:00:00+07:00", repeat: null });

// รูปแบบ ":" และ "น."
assert.equal(p("ประชุม 9:30").dateISO, "2026-06-16T09:30:00+07:00");
assert.equal(p("ประชุม 14.00น.").dateISO, "2026-06-16T14:00:00+07:00");
assert.equal(p("ตื่น 7น.").dateISO, "2026-06-16T07:00:00+07:00");

// ไม่มีเวลา -> date-only เหมือนเดิม (ไม่ regress)
assert.deepEqual(p("ซื้อของ พรุ่งนี้"), { title: "ซื้อของ", dateISO: "2026-06-17", repeat: null });

// "อีก 3 วัน" เลขต้องไม่ถูกตีความเป็นเวลา
assert.equal(p("เตือน อีก 3 วัน").dateISO, "2026-06-19");

// เวลาเกินช่วง -> ไม่ใช่เวลา (คงเป็น date-only, เลขค้างในชื่อ)
assert.equal(p("รหัส 25.99").dateISO, "2026-06-16");

// --- recurring quest ---

// คำสั่งทำซ้ำถูกแยกออกจากชื่อ + คงวันที่เดิม
assert.deepEqual(p("จ่ายค่าเน็ต ทุกเดือน สิ้นเดือน"),
  { title: "จ่ายค่าเน็ต", dateISO: "2026-06-30", repeat: "ทุกเดือน" });
assert.deepEqual(p("ออกกำลังกาย ทุกวัน"),
  { title: "ออกกำลังกาย", dateISO: "2026-06-16", repeat: "ทุกวัน" });
assert.equal(p("รดน้ำต้นไม้ ทุกอาทิตย์").repeat, "ทุกสัปดาห์");
assert.equal(p("ซื้อของ พรุ่งนี้").repeat, null); // ไม่ระบุ = null

// addMonths clamp วันสิ้นเดือน
assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
assert.equal(addMonths("2026-12-15", 1), "2027-01-15"); // ข้ามปี

// nextOccurrence เดินจากวันเดิมจนเลย today (รักษา anchor)
assert.equal(nextOccurrence("2026-06-16", "ทุกวัน", "2026-06-16"), "2026-06-17");
assert.equal(nextOccurrence("2026-06-16", "ทุกสัปดาห์", "2026-06-16"), "2026-06-23");
assert.equal(nextOccurrence("2026-06-16", "ทุกเดือน", "2026-06-16"), "2026-07-16");
// overdue: ข้ามทีละ period จนเลยวันนี้ (anchor คงวันในสัปดาห์)
assert.equal(nextOccurrence("2026-06-01", "ทุกสัปดาห์", "2026-06-20"), "2026-06-22");
// คงส่วนเวลา (datetime)
assert.equal(nextOccurrence("2026-06-16T12:00:00+07:00", "ทุกวัน", "2026-06-16"),
  "2026-06-17T12:00:00+07:00");
assert.equal(nextOccurrence("2026-06-16", null, "2026-06-16"), "2026-06-16"); // ไม่ซ้ำ = เดิม

console.log("ok");
