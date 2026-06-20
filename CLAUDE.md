# CLAUDE.md — Quest Tasks (Notion Reminder Chrome Extension)

ไฟล์นี้เป็น context สำหรับ Claude เวลากลับมาแก้ไขโปรเจกต์นี้ในอนาคต อ่านทั้งไฟล์ก่อนเริ่มแก้

## โปรเจกต์นี้คืออะไร

Chrome extension (Manifest V3) ที่ sync รายการ task กับ Notion database แล้วเด้งเตือนแบบ
"quest ในเกม" เมื่อ task ถึงกำหนด มี gamification (XP / level / streak) เพื่อสร้างแรงจูงใจให้เคลียร์งาน
ผู้ใช้คนเดียว (personal tool) ใช้ Internal Integration token — ยังไม่ได้ทำ OAuth สำหรับ publish

## สถาปัตยกรรม

โค้ดทั้งหมดอยู่ใต้ `src/` ยกเว้น `manifest.json` + `icons/` ที่ Chrome บังคับให้อยู่ root
path ใน manifest/HTML/import จึงอ้างแบบ relative (HTML อ้าง `../theme.css`, background เปิด `src/quest/quest.html`)

```
manifest.json            MV3 config (root). service_worker=src/background.js,
                         popup=src/popup/popup.html, options=src/options/options.html
icons/                   ไอคอน 16/48/128 (root — manifest อ้างถึง)
src/
  background.js          service worker (type: module) — แกนกลาง
    ├─ alarms            เช็คงานค้างเป็นระยะ (chrome.alarms, ขั้นต่ำ 15 นาที)
    ├─ badge             เลขงานค้างบนไอคอน
    ├─ quest window      เด้ง src/quest/quest.html (popup window) เมื่อมีงานถึงกำหนด
    ├─ context menu      "เพิ่มเป็น quest" จากข้อความที่เลือก
    └─ message API       popup/quest ส่ง message มาที่นี่
                         (status/queryDue/queryUpcoming/add/complete/snooze/setDate/rescheduleAlarm/refreshBadge/
                          queryUnread/addReading/markRead/archiveReading)
  lib/notion.js          ตัวห่อ Notion REST API ทั้งหมด (อยู่ที่เดียว) — quest functions + reading list functions
  lib/storage.js         config + game state (chrome.storage.local) + ตรรกะ XP/level/streak/rankLetter
  lib/thaiDate.js        parser วันที่ภาษาไทย + helper จัดการวันที่ (timezone Asia/Bangkok)
  popup/   (.html/js/css)   popup หลัก: 2 tab สลับด้วย bottom nav (เหมือน mobile app) —
                            "Quest" (งานวันนี้ + quick-add + XP bar) / "อ่านทีหลัง" (list + quick-add)
                            ทั้งสอง tab อยู่ใน DOM เดียวกัน สลับด้วย `hidden` attribute ไม่เปิด tab/window ใหม่
  quest/   (.html/js/css)   หน้าต่าง quest แบบเกม (signature UI) + animation + เสียง
  options/ (.html/js/css)   หน้าตั้งค่า + flow migrate ครั้งแรก (step 1-3 quest, step 4 reading database)
  theme.css              design tokens ใช้ร่วมทุกหน้า (HTML อ้าง ../theme.css)
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

6. **วันที่ของ task มี 2 รูปแบบ** — เก็บใน Notion date property เป็น `date.start`:
   - **date-only** `"2026-06-17"` (งานทั้งวัน)
   - **datetime** `"2026-06-17T12:00:00+07:00"` (งานที่ตั้งเวลา — ต้องมี offset `+07:00` เสมอ)
   โค้ดทุกที่ที่จัดการวันต้องรองรับทั้งสองแบบ: ตัดส่วนวันด้วย `.slice(0,10)`, ตรวจมีเวลาด้วย `.length > 10`,
   ส่วนเวลาคือ `.slice(10)` (`"T12:00:00+07:00"`) ดู `parseQuickAdd` (สร้าง) และ `isRipe` (background) เป็นตัวอย่าง

## convention ในโค้ด

- ชื่อ property ของ database เก็บใน `propMap` (storage) ไม่ hardcode — โค้ดอ้างชื่อผ่าน propMap เสมอ
  เผื่อผู้ใช้ rename column หรือใช้ database เดิม
- ทุก action ที่กระทบ badge / game state route ผ่าน background message API เพื่อให้ state เป็น single source
- error จาก Notion ใช้ class `NotionError` (มี status + code) — ดักได้ละเอียด เช่น 401 = token เสีย
- เก็บ key ทั้งหมดผ่าน `getConfig()/setConfig()` ไม่เรียก chrome.storage ตรงนอก storage.js
  (ยกเว้น reset ที่ใช้ chrome.storage.local.clear() และ `taskOrder` ที่ popup เขียนตรง — ดูด้านล่าง)
- **ลำดับ task ภายในวันเป็น local-only** — Notion ไม่มี property ลำดับ popup.js เก็บลำดับใน
  `chrome.storage.local.taskOrder` (array ของ page id) แล้ว `sortByOrder()` เรียงตามนั้น id ที่ไม่อยู่ในลิสต์
  เรียงตามวันเตือน (ต่อท้าย) การย้าย "วัน" ต่างหากที่ sync เข้า Notion (action `setDate`)
- **quest window เด้งตามเวลา** — `background.js` เก็บ `shownQuestState {date, ids}` กันเด้งซ้ำราย task ต่อวัน
  และใช้ `isRipe()` ตัดสินว่า task ถึงเวลาเด้งหรือยัง (date-only = ทั้งวัน, datetime = ต้องเลยเวลา) ความละเอียด
  = poll interval (ขั้นต่ำ 15 นาที ของ chrome.alarms) จะแม่นกว่านี้ต้องทำ per-task alarm (SW ตายง่าย ไม่คุ้ม)

> รายละเอียดฟีเจอร์ + ตาราง message API + จุดในโค้ด: ดู [`docs/FEATURES.md`](docs/FEATURES.md)

## Git workflow (กฎ — ต้องทำตาม)

**ทุกฟีเจอร์ใหม่ต้องแตก branch + เปิด PR ห้าม commit ฟีเจอร์ลง `main` ตรง ๆ**

1. แตกจาก `main` ล่าสุด: `git switch main && git pull && git switch -c feature/<slug>`
   (`<slug>` = kebab-case สั้น ๆ เช่น `feature/recurring-quest`)
2. ทำงาน + commit บน branch (commit message ลงท้ายด้วย `Co-Authored-By:` ตามปกติ)
3. **อัพเดท knowledge base ก่อน push เสมอ** (ดูด้านล่าง)
4. `git push -u origin feature/<slug>`
5. เปิด PR เข้า `main`: `gh pr create --base main --fill` (หรือใส่ title/body เอง)
6. merge ผ่าน PR แล้วลบ branch — อย่า push main ตรง

ยกเว้นได้เฉพาะงานจิ๋ม (typo / แก้ comment / docs) ที่ commit `main` ตรงได้
ใช้ skill `/feature <ชื่อฟีเจอร์>` เพื่อเริ่ม flow นี้อัตโนมัติ

### กฎ: อัพเดท knowledge base ก่อน push ทุกครั้ง

**ก่อน `git push` ใด ๆ** (ทั้ง branch และ main) ต้องอัพเดทเอกสารบริบทให้ตรงกับโค้ดล่าสุดก่อน
เป้าหมาย: Claude ใน session ถัดมาอ่านแล้วเข้าใจบริบทได้เลย ไม่ต้องไล่อ่านโค้ดใหม่ให้เปลือง token

ปรับเฉพาะที่ "เปลี่ยนจริง" ในรอบนั้น — ไม่ต้องเขียนใหม่ทั้งไฟล์:
- **`CLAUDE.md`** — โครงสร้างไฟล์, สถาปัตยกรรม, convention, message API, กฎ, รายการ TODO/สิ่งที่ยังไม่ทำ
  (เพิ่มฟีเจอร์ → ติ๊ก/เพิ่มใน TODO; เพิ่ม message action → เพิ่มในลิสต์ของ background; เพิ่ม/ย้ายไฟล์ → แก้ tree)
- **`docs/FEATURES.md`** — รายละเอียดฟีเจอร์ + จุดในโค้ด (เพิ่มฟีเจอร์ใหม่ → เพิ่ม section + ชี้ไฟล์/ฟังก์ชัน)
- ถ้าเปลี่ยนพฤติกรรมที่ผู้ใช้เห็น → อัพเดท `README.md` ด้วย

ถ้ารอบนั้นไม่กระทบบริบท (เช่นแก้ typo/format) เขียนกำกับใน commit/PR ว่า "no KB change" ได้

## วิธี load / ทดสอบ

1. `chrome://extensions` → เปิด Developer mode → Load unpacked → เลือกโฟลเดอร์นี้
2. กดไอคอน → "เปิดหน้าตั้งค่า" → ทำตาม step 1-3
3. ดู log: service worker ดูที่ `chrome://extensions` → ปุ่ม "service worker"; popup/quest/options คลิกขวา → Inspect
4. ทดสอบ alarm เร็ว ๆ: เปลี่ยน interval เป็น 15 หรือเรียก `chrome.alarms` ใน console ของ service worker
5. unit test: `node test/thaiDate.test.mjs` (หรือสั่ง `/test`) — ครอบ `parseQuickAdd`

## Claude config (`.claude/` — track ใน repo ยกเว้น `settings.local.json`)

- `settings.json` — shared permission allowlist (คำสั่ง read/test/branch ที่ปลอดภัย) ลด prompt
- `skills/feature/` — skill `/feature <slug>` (branch → KB update → push → PR)
- `commands/test.md` — command `/test` รัน unit test
- `settings.local.json` — permission เฉพาะเครื่อง (gitignore ไว้ ไม่แชร์)

## สิ่งที่ยังไม่ได้ทำ / TODO (สำคัญ)

- [x] **ทดสอบบน browser จริงแล้ว (v0.3)** — flow หลัก (quick-add, alarm/quest pop, drag-drop, date edit) ใช้งานได้
      ยังควร verify migrate flow + edge ของ recurring/pagination เมื่อแตะส่วนนั้น
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
- [ ] **Two-way sync ที่สมบูรณ์** — ดึงงานล่วงหน้า 3 วัน (`queryUpcoming`) + แก้วัน/เลื่อนจาก popup ได้แล้ว
      แต่ยังไม่ sync การแก้ไขฝั่ง Notion กลับมาแบบ realtime (ต้องกด refresh / รอ alarm)
- [ ] **เวลาในงาน sync ลำดับข้ามเครื่อง** — `taskOrder` เป็น local-only ถ้าใช้หลายเครื่องลำดับไม่ตรงกัน
- [x] **อ่านทีหลัง (Reading List)** — เมนูแยกจาก quest, database คนละตัว, capture ผ่าน context menu
      (เลือกข้อความ / คลิกขวาลิงก์), หน้า `src/reading/` เปิดเป็น tab ดู [`docs/FEATURES.md`](docs/FEATURES.md)
      ที่ยังไม่ทำ: UI แก้/ดู property `บันทึก` (rich_text), filter ตาม `แท็ก`, pagination ถ้ารายการเกิน ~100
