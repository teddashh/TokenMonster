#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { classifyWranglerR2Get } from "./wrangler-r2-get-policy.mjs";

const [exitCodeText, standardErrorPath, ...extra] = process.argv.slice(2);
if (
  extra.length !== 0 ||
  !/^(0|[1-9][0-9]*)$/u.test(exitCodeText ?? "") ||
  typeof standardErrorPath !== "string"
) {
  throw new Error(
    "Usage: classify-wrangler-r2-get.mjs <exit-code> <stderr-file>",
  );
}
const decision = classifyWranglerR2Get(
  Number(exitCodeText),
  await readFile(standardErrorPath, "utf8"),
);
process.stdout.write(decision);
