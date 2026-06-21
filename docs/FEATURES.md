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
สำหรับ action ที่กระทบ state — เรียกตรงได้เฉพาะ read ในหน้า options/migrate (เช่น test connection / migrate)

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
- `.appbar` (brand + lvl + ปุ่ม settings/refresh) เป็น `position: sticky` ติดบนเสมอ ใช้ร่วมกันทั้ง 2 tab
  `.topbar` (xp/quick-add ต่อ tab) ไม่ sticky แล้ว — เลื่อนตามเนื้อหาปกติ (ลดความซับซ้อนของ sticky ซ้อนกัน)
- `.bottom-nav` เป็น `position: fixed` เต็มความกว้าง popup สลับ `#view-quest`/`#view-reading` ด้วย `hidden`
  ปุ่มเป็น icon-only (เหมือน Facebook app บนมือถือ) ไม่มี text label, ใช้ `title`/`aria-label` แทน
- `body` fix สูง 600px (`overflow: hidden`), `.view` (เนื้อหาต่อ tab) เป็น flex:1 + `overflow-y: auto`
  scroll ในตัวเอง — ทำให้สลับ tab quest/อ่านทีหลัง แล้ว popup สูงเท่ากันเสมอ ไม่ resize ตามเนื้อหา

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
- UI: **อยู่ใน `popup.js` เดียวกับ quest** ไม่ใช่หน้าแยก — `#view-quest` / `#view-reading` เป็น 2 section
  ใน DOM เดียวกัน สลับด้วย bottom nav icon-only (`.bottom-nav` / `switchView()`) ผ่าน `hidden` attribute
  lazy-load: โหลด reading list ครั้งแรกตอนกดแท็บ (`readingLoaded` flag) ไม่โหลดถ้าไม่เคยกด
- setup: `migrate.html` (section "อ่านทีหลัง" — `reading-parent-select` / `reading-migrate-btn` /
  `reading-link-btn`) reuse list of accessible pages ที่โหลดมาจาก section quest (เลือก parent page เดียวกันได้)

### หน้า migrate แยกจาก options + portable core (`lib/migrate.js`)
- ปัญหาที่แก้: เดิม options.html มี step 2 (quest db) / step 4 (reading db) ปนกับ step token/settings
  ทำให้หน้าตั้งค่ายาว งง ว่า step ไหนทำอะไร — แยกการจัดการ database ทั้งหมดไปหน้า `migrate/migrate.html`
  ต่างหาก (options.html เหลือแค่ token + การเตือน + ล้างการตั้งค่า) เปิดจากปุ่ม "ไปหน้าจัดการ database →"
  ใน step 1 ของ options.html (โผล่หลังทดสอบ token สำเร็จ)
- `migrate.html` มี **section "Migrate" เดียว** ไม่แยก quest/reading เป็นคนละ section แล้ว — **ไม่มี
  toggle "สร้างใหม่ vs ใช้เดิม" อีกต่อไป** (ของเดิมงานเหมือนกันแค่ input คนละแบบ ผู้ใช้สับสนว่าต้อง
  เลือกโหมดทำไม) เหลือฟอร์มเดียว: เลือก parent page (ไม่บังคับ) + วาง database id ของ quest/reading
  ได้ทีละอัน (ไม่บังคับ) แล้วกดปุ่ม **"Migrate"** ปุ่มเดียว — `migrateOne()` (migrate.js) ตัดสินใจเองต่อ
  database: มี id ที่วางไว้ → เชื่อมด้วย id นั้น, ไม่มี id แต่ยังไม่เคย migrate + เลือก page ไว้ → สร้างใหม่,
  migrate ไปแล้วและไม่ได้วาง id ใหม่ → ข้าม (ฝั่งไหนมี dataSourceId อยู่แล้ว/ไม่กรอก id ก็ข้ามไปเฉย ๆ
  ไม่ error) ส่วน schema-check ยังแยก status/ปุ่มต่อ database อยู่ (เพราะ schema คนละชุดจริง ๆ) แต่อยู่ใต้
  section เดียวกัน ไม่ใช่คนละ card
- **จำ parent page ที่เคยเลือกไว้** — `loadPages()` อ่าน `cfg.questParentPageId`/`readingParentPageId`
  มา pre-select dropdown ให้ ไม่ต้องเลือก page ใหม่ทุกครั้งที่เปิดหน้า migrate ซ้ำ
- **ซ่อนฟอร์ม migrate ทั้งหมดเมื่อตั้งค่าครบแล้ว** — `refreshMigrateFormVisibility()` ซ่อน `#migrate-form`
  (เหลือแค่ schema-check + log) ทันทีที่ทั้ง `dataSourceId` และ `readingDataSourceId` มีค่าแล้ว แสดง
  ข้อความ "ตั้งค่าเสร็จแล้ว ✓" แทน
- ใต้ section migrate มี **section "Migration Log" แยก** ที่ query database "🛠 Migration Log" จาก
  Notion มาแสดงเป็นรายการ (เหตุการณ์ + เวอร์ชัน + รายละเอียด + เวลา) ตรง ๆ ไม่ต้องเปิด Notion เอง —
  ดู `notion.getMigrationLog()` + `migrate.fetchLog()` + `migrate.js → renderLog()`
- **`lib/migrate.js` เป็น core ที่ไม่แตะ `chrome.*` เลย** — `createDatabase()`/`linkDatabase()`/
  `checkDatabase()`/`updateDatabase()`/`writeLog()`/`fetchLog()` รับทุกอย่างผ่าน param (token,
  parentPageId, schemaDef, ฯลฯ) แล้วเรียก `lib/notion.js` (ก็ pure fetch เหมือนกัน) คืนผลลัพธ์ดิบ +
  `log` object ที่ host เอาไปเขียนต่อเอง — ตั้งใจให้ host (ตอนนี้คือ `migrate/migrate.js` ของ Chrome)
  เป็นแค่ชั้นบาง ๆ ที่ผูก `chrome.storage`/DOM เข้ากับ core นี้ เผื่อวันหน้าทำ host อื่น (Scriptable
  บน iOS) ใช้ core ไฟล์เดิมได้ทันที — **ยังไม่ได้เขียน Scriptable host จริง ตอนนี้แค่เตรียมโครงไว้**
- `migrate/migrate.js` (Chrome host): ทุก handler เรียก `migrate.xxx({...})` แล้วเอาผลไป
  `setConfig()`/อัปเดต DOM เอง — ไม่มี business logic อยู่ในไฟล์นี้เลย (ย้ายลง lib/migrate.js หมด)

### เช็ค & อัปเดต schema database + migration log (`lib/migrate.js` + `migrate/migrate.js`)
- ปัญหาที่แก้: ก่อนหน้านี้ถ้าเพิ่ม property ใหม่ในโค้ด (เช่น `บันทึก` ของ reading) คนที่ migrate database
  ไว้ก่อนหน้าจะขาด property นั้นไปเงียบ ๆ ไม่รู้ตัว
- `lib/notion.js` → `questSchema(propMap)` / `readingSchema(propMap)` เป็น **single source of truth**
  ของ schema ที่ทั้ง `createQuestDatabase`/`createReadingDatabase` (ตอนสร้างใหม่) และ `checkSchema`
  (ตอนเช็ค database ที่มีอยู่แล้ว) ใช้ร่วมกัน — แก้ schema ที่เดียว ทั้งสองทางเห็นตรงกันเสมอ
- `checkSchema(token, dataSourceId, schemaDef)` → `GET /data_sources/{id}` เทียบชื่อ+type property
  คืน `{ready, missing}` — ไม่เช็ค options ของ select/multi_select (Notion auto-เพิ่มเองตอน write)
- `updateSchema(token, dataSourceId, missing)` → `PATCH /data_sources/{id}` เพิ่มเฉพาะ property ที่ขาด
  **ไม่แก้ type ของ property ที่มีอยู่แล้วแต่ type ไม่ตรง** (เสี่ยงข้อมูลพัง) แค่ flag ไว้ในข้อความสถานะ
- UI ปุ่มเดียว (`#quest-schema-btn` / `#reading-schema-btn`): พร้อมแล้ว = disable + "เป็นปัจจุบันแล้ว ✓",
  ไม่พร้อม = enable + "อัปเดต database (+N)" เช็คอัตโนมัติทุกครั้งที่เปิดหน้า migrate (ถ้ามี dataSourceId แล้ว)
  และทุกครั้งหลัง create/link สำเร็จ
- migration log: `notion.ensureMigrationLogDataSource` สร้าง database "🛠 Migration Log" (title + number
  "เวอร์ชัน" + date "วันที่อัปเดต" + date "วันที่ออกเวอร์ชัน" + rich_text "รายละเอียด") ใต้ page แม่ของ
  database ที่ migrate ครั้งแรกที่มี event เกิดขึ้น (idempotent — ครั้งถัดไปใช้ id เดิมจาก
  `cfg.migrationLogDataSourceId`) ยังมี Notion `created_time` built-in ด้วย (= เวลาบันทึก log จริง)
  แยกจาก 2 date property ข้างบนซึ่งเป็น **ความหมายทางธุรกิจ** ไม่ใช่ timestamp ของระบบ:
  - **"วันที่อัปเดต"** = วันที่ user สั่ง migrate database นี้จริง (คำนวณจาก `bangkokToday()` ฝั่ง host
    ตอนคลิกปุ่ม — core (`lib/migrate.js`) ไม่เรียก "now" เองเพื่อให้ deterministic/testable)
  - **"วันที่ออกเวอร์ชัน"** = วันที่ codebase เปลี่ยน schema เวอร์ชันนั้นจริง ๆ มาจาก
    `QUEST_SCHEMA_RELEASES`/`READING_SCHEMA_RELEASES` (notion.js) เช่น `{ 1: "2026-06-21" }` —
    **ต้องเพิ่ม entry ใหม่คู่กับการ bump `*_SCHEMA_VERSION` ทุกครั้ง** ไม่งั้น log จะโชว์วันที่ของ
    เวอร์ชันก่อนหน้าผิด ๆ
- **bug ที่เจอ + วิธีแก้**: database "🛠 Migration Log" ที่สร้างไว้ก่อนเพิ่ม property วันที่ 2 ตัวนี้
  จะไม่มี property นั้นในตัวเอง — ของเดิม `ensureMigrationLogDataSource` ถ้าเจอ `existingDataSourceId`
  จะ return ทันทีไม่เช็ค schema เลย ทำให้ `logMigration` ครั้งถัดไปเขียน property ที่ data source ไม่มี
  จริง Notion ปฏิเสธ (400) แล้ว `writeLog()` ฝั่ง host catch เงียบ ๆ ไว้ — log แถวใหม่ไม่ถูกสร้างเลย
  ไม่ใช่แค่ไม่มีวันที่ **แก้แล้ว**: `ensureMigrationLogDataSource` self-heal ทุกครั้ง — เช็ค schema ของ
  log database เดิมก่อนคืนค่า ถ้าขาด property ไหน `updateSchema()` เติมให้อัตโนมัติ (เหมือนที่ทำกับ
  quest/reading) และ `writeLog()` ฝั่ง host ไม่กลืน error เงียบอีกแล้ว — error จะโผล่ต่อท้าย
  `#migrate-status` ให้เห็นด้วย
- `notion.logMigration` เขียน 1 row ต่อ **ทุก connect event** ไม่ใช่แค่ตอนอัปเดตสำเร็จ — สร้างใหม่/เชื่อมเดิม/
  อัปเดต ทั้งสามเหตุการณ์เรียก `migrate.writeLog()` (lib/migrate.js) ผ่าน `writeLog()` ของ host
  (migrate/migrate.js — ผูกกับ `chrome.storage` ก่อนเรียก) เสมอ แม้ผลเช็คคือ "ครบอยู่แล้ว ไม่ต้อง
  อัปเดต" ก็ log ไว้ด้วย — กันเคสที่ผู้ใช้เชื่อม database ที่มี schema ตรงอยู่แล้ว แล้วงงว่าทำไม log ว่าง
- `QUEST_SCHEMA_VERSION` / `READING_SCHEMA_VERSION` (notion.js) — bump เลขนี้ทุกครั้งที่แก้
  `questSchema()`/`readingSchema()` แล้วทุก log entry หลังจากนั้นจะพ่วงเลขเวอร์ชันนี้ไปด้วย เปิด
  database "🛠 Migration Log" ใน Notion แล้วเรียง column "เวอร์ชัน" จากมากไปน้อย แถวบนสุด = เวอร์ชัน
  ล่าสุดที่ database นั้นอยู่ ไม่ต้องเปิดโค้ดมาไล่เทียบ property เอง
- ต้องมี **parent page** ของ database นั้นถึงจะสร้าง log ได้ — `resolveDataSourceId` (โหมด "ใช้ database
  เดิม") ดึง `parentPageId` จาก `data.parent` ของ Notion response ส่วน `createQuestDatabase`/
  `createReadingDatabase` (โหมดสร้างใหม่) รู้ parentPageId อยู่แล้วเพราะเป็น argument ที่ส่งเข้าไป
  ถ้า parent เป็น workspace root (ไม่มี page แม่) จะข้าม log แบบเงียบ ๆ ไม่ error (อัปเดต schema สำเร็จตามปกติ)

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
  readingParentPageId,                             // page แม่ของ reading database
  readingPropMap: { title, url, tag, done, note },

  questParentPageId,                                // page แม่ของ quest database
  migrationLogDatabaseId, migrationLogDataSourceId  // "🛠 Migration Log" — สร้างครั้งแรกตอน schema อัปเดต
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
