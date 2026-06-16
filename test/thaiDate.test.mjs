// node test/thaiDate.test.mjs  — assert-based, no framework
import assert from "node:assert";
import { parseQuickAdd } from "../lib/thaiDate.js";

const base = "2026-06-16";
const p = (s) => parseQuickAdd(s, base);

// เวลาแยกออกจากชื่อ ไปอยู่ใน dateISO (เคสหลักที่ผู้ใช้รายงาน)
assert.deepEqual(p("ออกไปกินข้าว 16/6/26 12.00"),
  { title: "ออกไปกินข้าว", dateISO: "2026-06-16T12:00:00+07:00" });

// เวลาอย่างเดียว ไม่มีวัน -> วันนี้ + เวลา
assert.deepEqual(p("ออกไปกินข้าว 12.00"),
  { title: "ออกไปกินข้าว", dateISO: "2026-06-16T12:00:00+07:00" });

// รูปแบบ ":" และ "น."
assert.equal(p("ประชุม 9:30").dateISO, "2026-06-16T09:30:00+07:00");
assert.equal(p("ประชุม 14.00น.").dateISO, "2026-06-16T14:00:00+07:00");
assert.equal(p("ตื่น 7น.").dateISO, "2026-06-16T07:00:00+07:00");

// ไม่มีเวลา -> date-only เหมือนเดิม (ไม่ regress)
assert.deepEqual(p("ซื้อของ พรุ่งนี้"), { title: "ซื้อของ", dateISO: "2026-06-17" });

// "อีก 3 วัน" เลขต้องไม่ถูกตีความเป็นเวลา
assert.equal(p("เตือน อีก 3 วัน").dateISO, "2026-06-19");

// เวลาเกินช่วง -> ไม่ใช่เวลา (คงเป็น date-only, เลขค้างในชื่อ)
assert.equal(p("รหัส 25.99").dateISO, "2026-06-16");

console.log("ok");
