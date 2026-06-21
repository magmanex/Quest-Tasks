// node test/version.test.mjs  — assert-based, no framework
import assert from "node:assert";
import { compareVersions } from "../src/lib/version.js";

assert.equal(compareVersions("0.2.0", "0.1.0"), 1);   // ใหม่กว่า
assert.equal(compareVersions("0.1.0", "0.2.0"), -1);  // เก่ากว่า
assert.equal(compareVersions("0.1.0", "0.1.0"), 0);   // เท่ากัน
assert.equal(compareVersions("1.0.0", "0.9.9"), 1);   // major ชนะ minor/patch
assert.equal(compareVersions("0.10.0", "0.9.0"), 1);  // 10 > 9 (ตัวเลข ไม่ใช่ string)
assert.equal(compareVersions("1.2", "1.2.0"), 0);     // segment ขาด = 0

console.log("ok");
