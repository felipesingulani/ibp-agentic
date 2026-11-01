/**
 * L1 — confere os md5 golden de harness/pins.json.
 * Uso: npm run harness:pins
 */
import { loadPins, md5File } from "./lib.js";

const pins = loadPins();
let fail = 0;
for (const pin of pins) {
  let got: string;
  try {
    got = md5File(pin.path);
  } catch (e) {
    console.log(`FAIL ${pin.path} MISSING (${e instanceof Error ? e.message : e})`);
    fail++;
    continue;
  }
  if (got === pin.md5) console.log(`OK   ${pin.md5}  ${pin.path}`);
  else {
    console.log(`FAIL ${pin.path}`);
    console.log(`  expected ${pin.md5}`);
    console.log(`  actual   ${got}`);
    fail++;
  }
}
if (fail) {
  console.error(`pins: ${fail} falha(s) / ${pins.length}`);
  process.exit(1);
}
console.log(`pins: ${pins.length} ok`);
