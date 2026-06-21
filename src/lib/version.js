// lib/version.js — เช็คเวอร์ชันล่าสุดจาก GitHub
// portable: ใช้ fetch อย่างเดียว ไม่แตะ chrome.*/document (เผื่อพอร์ตไป host อื่น เหมือน notion.js)
// เทียบ "version" ใน manifest.json บน branch หลัก กับเวอร์ชันที่ติดตั้งอยู่ในเครื่อง

export const REPO_URL = "https://github.com/magmanex/Quest-Tasks";
export const RAW_MANIFEST_URL =
  "https://raw.githubusercontent.com/magmanex/Quest-Tasks/main/manifest.json";

// เทียบ semver: a>b -> 1, a==b -> 0, a<b -> -1 (เทียบทีละ segment เป็นตัวเลข)
export function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ดึง version ล่าสุดจาก GitHub raw manifest — โยน error ถ้าเน็ตล่ม/ฟอร์แมตพัง
// (raw.githubusercontent.com ส่ง CORS header `*` จึง fetch ตรงได้ ไม่ต้องมี host_permissions)
export async function fetchLatestVersion(url = RAW_MANIFEST_URL) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const manifest = await res.json();
  if (!manifest.version) throw new Error("ไม่พบ version ใน manifest");
  return manifest.version;
}
