// lib/thaiDate.js
// แปลงข้อความภาษาไทยแบบ quick-add ให้เป็น { title, dateISO }
// รองรับ: วันนี้ / พรุ่งนี้ / มะรืน / สิ้นเดือน / สัปดาห์หน้า / อีก N วัน
//          ชื่อวัน (จันทร์..อาทิตย์, มี "หน้า" ต่อท้ายได้) / วันที่ dd/mm[/yyyy]
// ถ้าไม่เจอวันใด ๆ -> ใช้วันนี้
//
// timezone อ้างอิง Asia/Bangkok เสมอ (เลี่ยงปัญหาวันคลาดช่วงเที่ยงคืน)

export function bangkokToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" }); // YYYY-MM-DD
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function lastDayOfMonth(iso) {
  const [y, m] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m, 0)); // วันที่ 0 ของเดือนถัดไป = วันสุดท้ายเดือนนี้
  return dt.toISOString().slice(0, 10);
}

const WEEKDAYS = {
  "อาทิตย์": 0, "จันทร์": 1, "อังคาร": 2, "พุธ": 3,
  "พฤหัส": 4, "พฤหัสบดี": 4, "ศุกร์": 5, "เสาร์": 6
};

function dowOf(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// หาวันถัดไปที่ตรงกับ weekday เป้าหมาย (ถ้าวันนี้ตรงพอดีและ forceNext=false คืนวันนี้)
function nextWeekday(todayISO, target, forceNext) {
  const cur = dowOf(todayISO);
  let diff = (target - cur + 7) % 7;
  if (diff === 0 && forceNext) diff = 7;
  if (diff === 0 && !forceNext) diff = 0;
  return addDays(todayISO, diff);
}

// คืน { title, dateISO } — แยกวลีวันออกจากชื่องาน
export function parseQuickAdd(input, baseISO = bangkokToday()) {
  let text = (input || "").trim();
  let dateISO = null;
  let timeStr = null; // "HH:MM"

  // เวลา เช่น 12.00 / 9:30 / 14.00น. — parse ก่อน date กัน "12.00" หลุดไปอยู่ในชื่องาน
  // ponytail: รองรับ HH:MM / HH.MM และชั่วโมงเดี่ยวที่ลงท้าย "น." (เช่น "บ่าย 2") ค่อยเพิ่มถ้าต้องการ
  {
    const tm = text.match(/\b(\d{1,2})[.:](\d{2})\s*(?:น\.?)?/);
    if (tm && +tm[1] < 24 && +tm[2] < 60) {
      timeStr = `${String(+tm[1]).padStart(2, "0")}:${tm[2]}`;
      text = text.replace(tm[0], " ").replace(/\s+/g, " ").trim();
    } else {
      const th = text.match(/\b(\d{1,2})\s*น\.?/); // ชั่วโมงเดี่ยวต้องมี "น." กันชนเลขอื่น
      if (th && +th[1] < 24) {
        timeStr = `${String(+th[1]).padStart(2, "0")}:00`;
        text = text.replace(th[0], " ").replace(/\s+/g, " ").trim();
      }
    }
  }

  const tryMatch = (regex, resolver) => {
    if (dateISO) return;
    const m = text.match(regex);
    if (m) {
      dateISO = resolver(m);
      text = text.replace(m[0], " ").replace(/\s+/g, " ").trim();
    }
  };

  // วันที่ชัดเจน dd/mm หรือ dd/mm/yyyy (รองรับปี พ.ศ.)
  tryMatch(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, (m) => {
    const d = +m[1], mo = +m[2];
    let y = m[3] ? +m[3] : +baseISO.slice(0, 4);
    if (y > 2400) y -= 543;          // ปี พ.ศ. -> ค.ศ.
    if (y < 100) y += 2000;          // ปีสองหลัก
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  });

  tryMatch(/มะรืน(?:นี้)?/, () => addDays(baseISO, 2));
  tryMatch(/พรุ่งนี้|พรุ้งนี้/, () => addDays(baseISO, 1));
  tryMatch(/วันนี้/, () => baseISO);
  tryMatch(/สิ้นเดือน|สิ้นเดือนนี้/, () => lastDayOfMonth(baseISO));
  tryMatch(/สัปดาห์หน้า|อาทิตย์หน้า(?!\s*[ก-๙])/, () => addDays(baseISO, 7));
  tryMatch(/อีก\s*(\d+)\s*วัน/, (m) => addDays(baseISO, +m[1]));

  // ชื่อวัน เช่น "วันศุกร์", "ศุกร์หน้า", "วันจันทร์หน้า"
  tryMatch(
    /(?:วัน)?(อาทิตย์|จันทร์|อังคาร|พุธ|พฤหัสบดี|พฤหัส|ศุกร์|เสาร์)(หน้า)?/,
    (m) => nextWeekday(baseISO, WEEKDAYS[m[1]], Boolean(m[2]))
  );

  if (!dateISO) dateISO = baseISO;
  if (timeStr) dateISO = `${dateISO}T${timeStr}:00+07:00`; // Bangkok offset เพื่อให้ Notion เก็บเวลาด้วย

  // เก็บกวาดคำเชื่อมที่ค้างท้ายชื่อ เช่น "โอนเงิน ตอน" -> "โอนเงิน"
  const title = text.replace(/\s*(ตอน|ภายใน|ใน|วัน|เวลา)\s*$/g, "").trim();
  return { title: title || input.trim(), dateISO };
}
