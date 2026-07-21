import { access, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { mergeAndSaveDailyProviderBuckets } from "../dist/index.js";

const [storePath, utcDate, tokenText, readyPath, goPath] = process.argv.slice(2);
const tokens = Number(tokenText);
if (
  [storePath, utcDate, readyPath, goPath].some(
    (value) => typeof value !== "string" || value.length === 0,
  ) ||
  !Number.isSafeInteger(tokens) ||
  tokens < 1
) {
  throw new Error("invalid progression-store child arguments");
}

await writeFile(readyPath, "ready\n", { flag: "wx", mode: 0o600 });
let released = false;
// Ten cold Node processes can take more than ten seconds to import on a
// resource-constrained CI host. Keep the child-side barrier comfortably wider
// than the parent readiness deadline so an early child cannot time out while a
// later sibling is still starting.
for (let attempt = 0; attempt < 12_000; attempt += 1) {
  try {
    await access(goPath);
    released = true;
    break;
  } catch {
    await delay(5);
  }
}
if (!released) throw new Error("progression-store child barrier timed out");

await mergeAndSaveDailyProviderBuckets(
  [{ utcDate, providerTotals: { openai: tokens } }],
  { path: storePath },
);
process.stdout.write(`${utcDate}\n`);
