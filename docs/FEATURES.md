# docs/FEATURES.md — แคตตาล็อกฟีเจอร์ + จุดในโค้ด

อ่านคู่กับ `CLAUDE.md` (กฎเหล็ก Notion API + convention) ไฟล์นี้บอกว่า "ฟีเจอร์ไหนอยู่ตรงไหน"
จะได้กระโดดไปแก้ถูกจุดโดยไม่ต้องไล่อ่านทั้ง repo อัปเดตไฟล์นี้เมื่อเพิ่ม/ย้ายฟีเจอร์

## ภาพรวม flow

```
popup.js / quest.js  ──sendMessage──▶  background.js (handleMessage)  ──▶  lib/notion.js  ──▶  Notion API
      ▲                                        │
      └────────────── response ────────────────┘
```

ทุก action ที่กระทบ badge หรือ game state ต้องผ่าน background (single source) popup ห้ามเรียก notion.js ตรง
สำหรับ action ที่กระทบ state — เรียกตรงได้เฉพาะ read ในหน้า options (เช่น test connection / migrate)

## message API (background.js → `handleMessage`)

| action          | params                         | คืนค่า                                   | หมายเหตุ |
|-----------------|--------------------------------|------------------------------------------|----------|
| `status`        | —                              | `{ok, setup, game}`                      | setup = มี token+dataSourceId ไหม |
| `queryDue`      | —                              | `{ok, tasks, game}`                      | งาน date ≤ วันนี้ & ยังไม่เสร็จ + อัปเดต badge |
| `queryUpcoming` | `{days}`                       | `{ok, tasks}`                            | งานช่วง (วันนี้, +days] — popup ขอ days=3 |
| `add`           | `{title, dateISO, rank}`       | `{ok, task}`                             | dateISO เป็น date-only หรือ datetime ก็ได้ |
| `complete`      | `{pageId, rank}`               | `{ok, reward, remaining, game}`          | ให้ XP + อัปเดต streak ถ้าเคลียร์ครบวัน |
| `snooze`        | `{pageId, days}`               | `{ok, remaining}`                        | เลื่อน = `addDays(วันนี้, days||1)` |
| `setDate`       | `{pageId, dateISO}`            | `{ok, remaining}`                        | ตั้งวันแบบเจาะจง (drag ข้ามวัน / date picker) |
| `rescheduleAlarm`| —                             | `{ok}`                                   | เรียกหลังเปลี่ยน checkIntervalMinutes |
| `refreshBadge`  | —                              | `{ok}`                                   | คำนวณ badge ใหม่ |
| `queryUnread`   | —                              | `{ok, items}`                            | "อ่านทีหลัง" ที่ยังไม่อ่าน เรียงใหม่สุดก่อน |
| `addReading`    | `{title, url?, tag?}`          | `{ok, item}`                             | เพิ่มเข้า reading database |
| `markRead`      | `{pageId}`                     | `{ok}`                                   | ติ๊กว่าอ่านแล้ว |
| `archiveReading`| `{pageId}`                     | `{ok}`                                   | archive page (soft delete, กู้ได้ใน Notion trash) |

`snooze` กับ `setDate` ใช้ `notion.snoozeTask()` ตัวเดียวกัน (set `date.start`) ต่างกันแค่คำนวณวันที่ฝั่ง caller

## ฟีเจอร์ → ไฟล์/ฟังก์ชัน

### Quick-add ภาษาไทย + เวลา
- `lib/thaiDate.js` → `parseQuickAdd(input, baseISO)` คืน `{title, dateISO}`
- แยกวลีวัน (วันนี้/พรุ่งนี้/มะรืน/สิ้นเดือน/สัปดาห์หน้า/อีก N วัน/ชื่อวัน/`dd/mm[/yyyy]` รองรับ พ.ศ.)
- แยก **เวลา** ออกจากชื่องาน: `12.00` / `9:30` / `14.00น.` / `7น.` → ผนวกเป็น datetime `...T HH:MM:00+07:00`
- test: `node test/thaiDate.test.mjs`

### Quest pop ตามเวลา (time-based)
- `background.js` → `runDueCheck()` + `isRipe(task, nowMs)`
- `isRipe`: date-only = ถึงทั้งวัน, datetime = ต้อง `new Date(date) <= now`
- กันเด้งซ้ำด้วย `shownQuestState {date, ids}` (เก็บใน storage) — reset เมื่อขึ้นวันใหม่
- ความละเอียด = poll interval (`settings.checkIntervalMinutes`, ขั้นต่ำ 15) ตั้งใน `ensureAlarm()`

### Drag & drop (popup.js)
- `makeDraggable(el, task)` — ทำ element ลากได้ + เก็บ `dataset.id`; ไม่เริ่มลากถ้า target เป็น `<input>`
- `makeReorderTarget(el, task)` — drop ลงบน task อีกอัน: วันเดียวกัน = จัดลำดับ (local), คนละวัน = `setDate`
- `makeDropZone(el, targetDay)` — drop ลงพื้นที่วัน (today list หรือ day group) = `setDate` ไปวันนั้น
- ทุกครั้งคง **เวลาเดิม** ไว้: `time = from.length > 10 ? from.slice(10) : ""`

### ลำดับ task ภายในวัน (local-only)
- `orderIds` (module var) sync กับ `chrome.storage.local.taskOrder`
- `loadOrder()` โหลดตอนเปิด popup, `sortByOrder(tasks)` เรียง, `reorderInContainer()` อ่านลำดับจริงจาก DOM แล้วเขียนกลับ
- ไม่ยุ่ง Notion เลย (Notion ไม่มี property ลำดับ)

### รายการล่วงหน้า 3 วัน (popup.js → `renderUpcoming`)
- แสดงพรุ่งนี้ + อีก 2 วัน แต่ละวันเป็น block collapse แยกกัน (`expandedDays` Set จำสถานะใน session)
- หัวข้อแต่ละวันมีเลขนับ task; วันว่างโชว์ "ไม่มีงาน"
- แต่ละแถวมี date picker (`<input type="date">`) เปลี่ยนวันแบบเจาะจง → `setDate` (ดู `makeUpcomingRow`)

### UI chrome (popup)
- `send()` ห่อ `chrome.runtime.sendMessage` + นับ request ค้าง → โชว์ `#syncbar` (loading bar ทอง) ตอน sync
- `.topbar` (brand→quick-add) และ `.foot` เป็น `position: sticky` + เงา = layer บน
- รายการวันนี้ (`.list`) สูงตามเนื้อหา (ไม่ fix height) popup จะสูงจน Chrome cap (~600px) แล้วค่อย scroll

### Gamification
- `lib/storage.js` → `xpForRank` / `levelFromXp` / `applyReward` / `updateStreakIfCleared`
- state อยู่ใน `config.game {xp, level, streak, lastClearedDate}`

### อ่านทีหลัง (Reading List) — เมนูแยกจาก quest
- database คนละตัวจาก quest, คนละ data source id (`readingDataSourceId`) ไม่มี XP/due date/quest pop
- schema: `ชื่อเรื่อง` (title), `ลิงก์` (url), `แท็ก` (multi_select), `อ่านแล้ว` (checkbox), `บันทึก` (rich_text ยังไม่มี UI แก้)
  เรียงด้วย Notion built-in `created_time` timestamp ไม่ต้องมี date property
- `lib/notion.js` → `createReadingDatabase` / `createReadingItem` / `getUnreadItems` / `markReadItem` / `archiveReadingItem`
- capture: context menu 2 อัน ใน `background.js` — `addReadingFromSelection` (เลือกข้อความ, url = tab ปัจจุบัน),
  `addReadingFromLink` (คลิกขวาที่ลิงก์, url = `info.linkUrl`)
- UI: `src/reading/reading.html` เปิดเป็น **tab ปกติ** (`chrome.tabs.create`, ไม่ใช่ popup window แบบ quest)
  เพราะ list อาจยาว ต้อง scroll สบาย เปิดจากปุ่ม "📚 อ่านทีหลัง" ใน `popup.html` footer
- setup: `options.html` step 4 (`reading-parent-select` / `reading-migrate-btn` / `reading-link-btn`)
  reuse list of accessible pages ที่โหลดมาจาก step 2 (เลือก parent page เดียวกับ quest ได้)

## รูปทรงข้อมูล (chrome.storage.local)

```js
// ผ่าน getConfig()/setConfig() (DEFAULTS ใน lib/storage.js)
{
  token, databaseId, dataSourceId,
  propMap: { title, date, done, rank },           // ชื่อ column จริงใน Notion
  settings: {
    checkIntervalMinutes,                          // ขั้นต่ำ 15
    timezone, autoOpenQuestWindow,
    quietHours: { enabled, start, end }            // ช่วงห้ามเด้ง (badge ยังขึ้น)
  },
  game: { xp, level, streak, lastClearedDate },
  shownQuestState: { date, ids: [] },              // กัน quest เด้งซ้ำราย task ต่อวัน

  readingDatabaseId, readingDataSourceId,          // "อ่านทีหลัง" — database คนละตัวจาก quest
  readingPropMap: { title, url, tag, done, note }
}

// เขียนตรงโดย popup.js (ไม่ผ่าน storage.js) — local-only ไม่ sync Notion
taskOrder: [pageId, ...]                           // ลำดับ task ที่ผู้ใช้จัดเอง
```

## task object (หลัง `normalizeTask` ใน notion.js)

```js
{ id, title, date, rank, url }
// date = date.start ดิบจาก Notion: "2026-06-17" หรือ "2026-06-17T12:00:00+07:00"
// url  = ลิงก์หน้า Notion (ใช้ปุ่ม "↗ Notion" แก้/ลบ)
```

## reading item object (หลัง `normalizeReadingItem` ใน notion.js)

```js
{ id, title, url, tags: [], done, createdTime, notionUrl }
// url       = ลิงก์ที่เก็บไว้อ่าน (ไม่ใช่ลิงก์หน้า Notion — นั้นคือ notionUrl)
// createdTime = ISO timestamp ของ Notion (สร้างตอน capture) ใช้ sort แทน date property
```
