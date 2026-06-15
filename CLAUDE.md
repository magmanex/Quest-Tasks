# CLAUDE.md — Quest Tasks (Notion Reminder Chrome Extension)

ไฟล์นี้เป็น context สำหรับ Claude เวลากลับมาแก้ไขโปรเจกต์นี้ในอนาคต อ่านทั้งไฟล์ก่อนเริ่มแก้

## โปรเจกต์นี้คืออะไร

Chrome extension (Manifest V3) ที่ sync รายการ task กับ Notion database แล้วเด้งเตือนแบบ
"quest ในเกม" เมื่อ task ถึงกำหนด มี gamification (XP / level / streak) เพื่อสร้างแรงจูงใจให้เคลียร์งาน
ผู้ใช้คนเดียว (personal tool) ใช้ Internal Integration token — ยังไม่ได้ทำ OAuth สำหรับ publish

## สถาปัตยกรรม

```
manifest.json        MV3 config. host_permissions = https://api.notion.com/*
background.js        service worker (type: module) — แกนกลาง
  ├─ alarms          เช็คงานค้างเป็นระยะ (chrome.alarms, ขั้นต่ำ 15 นาที)
  ├─ badge           เลขงานค้างบนไอคอน
  ├─ quest window    เด้ง quest.html (popup window) เมื่อมีงานถึงกำหนด
  ├─ context menu    "เพิ่มเป็น quest" จากข้อความที่เลือก
  └─ message API     popup/quest ส่ง message มาที่นี่ (queryDue/add/complete/snooze/...)

lib/notion.js        ตัวห่อ Notion REST API ทั้งหมด (อยู่ที่เดียว)
lib/storage.js       config + game state (chrome.storage.local) + ตรรกะ XP/level/streak
lib/thaiDate.js      parser วันที่ภาษาไทย + helper จัดการวันที่ (timezone Asia/Bangkok)

popup.html/js/css    popup หลัก: ดูงานวันนี้ + quick-add + XP bar
quest.html/js/css    หน้าต่าง quest แบบเกม (signature UI) + animation + เสียง
options.html/js/css  หน้าตั้งค่า + flow migrate ครั้งแรก
theme.css            design tokens ใช้ร่วมทุกหน้า
icons/               ไอคอน 16/48/128
```

## กฎเหล็กของ Notion API (อ่านก่อนแตะโค้ดที่เรียก Notion)

1. **ใช้ API version `2025-09-03`** (กำหนดใน `lib/notion.js` ค่า `NOTION_VERSION`)
   model ใหม่แยก database (container) ออกจาก data source
   - query / create page ต้องใช้ **`data_source_id`** ไม่ใช่ `database_id`
   - endpoint query: `POST /v1/data_sources/{dataSourceId}/query`
   - สร้าง page: `POST /v1/pages` โดย `parent: { type: "data_source_id", data_source_id }`
   - สร้าง database: `POST /v1/databases` โดย properties ห่อใน `initial_data_source`
   - search filter ใช้ค่า `"page" | "data_source"` (ไม่มี `"database"` แล้ว)
   - ถ้า version ใหม่กว่านี้ออกมา (เช่น 2026-03-11) อัปได้ที่ค่าเดียว แต่เช็ค breaking change ก่อน

2. **CORS** — Notion API ไม่ส่ง CORS header ฟังก์ชันใน `notion.js` เรียกได้จาก
   service worker หรือ extension page (popup/options/quest) เท่านั้น **ห้ามเรียกจาก content script**
   (ตอนนี้ยังไม่มี content script — ถ้าจะเพิ่ม ให้ route ผ่าน background ด้วย sendMessage)

3. **Integration capabilities** — ต้องเปิด Read + Update + Insert ใน Notion ไม่งั้น write จะ fail

4. **Parent page** — สร้าง database ที่ root ของ workspace ไม่ได้ ต้องมี parent page ที่ integration
   เข้าถึงได้ก่อน (flow ใน options.js: ผู้ใช้ share page → listAccessiblePages → เลือก → createQuestDatabase)

5. **Timezone** — คำนวณ "วันนี้" ด้วย `bangkokToday()` เสมอ (Asia/Bangkok) อย่าใช้ UTC ตรง ๆ

## convention ในโค้ด

- ชื่อ property ของ database เก็บใน `propMap` (storage) ไม่ hardcode — โค้ดอ้างชื่อผ่าน propMap เสมอ
  เผื่อผู้ใช้ rename column หรือใช้ database เดิม
- ทุก action ที่กระทบ badge / game state route ผ่าน background message API เพื่อให้ state เป็น single source
- error จาก Notion ใช้ class `NotionError` (มี status + code) — ดักได้ละเอียด เช่น 401 = token เสีย
- เก็บ key ทั้งหมดผ่าน `getConfig()/setConfig()` ไม่เรียก chrome.storage ตรงนอก storage.js
  (ยกเว้น reset ที่ใช้ chrome.storage.local.clear())

## วิธี load / ทดสอบ

1. `chrome://extensions` → เปิด Developer mode → Load unpacked → เลือกโฟลเดอร์นี้
2. กดไอคอน → "เปิดหน้าตั้งค่า" → ทำตาม step 1-3
3. ดู log: service worker ดูที่ `chrome://extensions` → ปุ่ม "service worker"; popup/quest/options คลิกขวา → Inspect
4. ทดสอบ alarm เร็ว ๆ: เปลี่ยน interval เป็น 15 หรือเรียก `chrome.alarms` ใน console ของ service worker

## สิ่งที่ยังไม่ได้ทำ / TODO (สำคัญ)

- [ ] **ยังไม่ได้ทดสอบบน browser จริง** — โค้ดผ่าน syntax check + unit test ของ parser แล้ว
      แต่ flow ทั้งหมด (migrate, alarm, quest window) ต้อง verify ด้วยมือใน Chrome
- [ ] **Recurring quest** — งานประจำ (เช่นโอนเงินทุกสิ้นเดือน) ยังไม่ทำ ต้องเพิ่ม property เช่น
      "ทำซ้ำ" แล้วตอน complete ให้ createTask occurrence ถัดไป (Notion ไม่มี recurrence ใน API)
- [ ] **Offline queue + retry** — ถ้า write fail (เน็ตหลุด / service worker ถูก kill) ยังไม่มี queue
      ควรเก็บ pending writes ใน storage แล้ว retry ตอน alarm ถัดไป
- [ ] **Pagination** — `getDueTasks` ดึงหน้าเดียว (ไม่เกิน ~100 รายการ) ถ้างานค้างเยอะกว่านั้น
      ต้องวน `next_cursor`
- [ ] **Notification action buttons** — ปุ่ม Done/Snooze บน system notification ยังไม่ทำ
- [ ] **เลือก rank ตอน quick-add** — ตอนนี้ quick-add ตั้ง rank เป็น "B - ปกติ" ตายตัว
- [ ] **UI แก้ propMap** — ถ้าใช้ database เดิมที่ชื่อ column ต่าง ต้องแก้ใน code/storage เอง ยังไม่มี UI
- [ ] **OAuth** — ตอนนี้ใช้ internal token (plaintext ใน storage) ปลอดภัยพอสำหรับใช้เอง
      แต่ถ้าจะ publish ลง Chrome Web Store ต้องทำ OAuth flow + backend แลก token
- [ ] **Two-way sync ที่สมบูรณ์** — ตอนนี้แค่ poll งานที่ถึงกำหนด ไม่ได้ดึงงานอนาคต/แก้ไขจากฝั่ง Notion มาโชว์
