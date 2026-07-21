#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { planWorkerPublication } from "./worker-publication-policy.mjs";

const argv = process.argv.slice(2);
const values = new Map();
let missing = false;
for (let index = 0; index < argv.length; index += 1) {
  const name = argv[index];
  if (name === "--missing") {
    if (missing) throw new Error("--missing may be supplied only once");
    missing = true;
    continue;
  }
  if (!["--current", "--candidate"].includes(name)) {
    throw new Error(`unknown Worker publication argument: ${name}`);
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--") || values.has(name)) {
    throw new Error(`invalid Worker publication argument: ${name}`);
  }
  values.set(name, value);
  index += 1;
}
if (
  !values.has("--candidate") ||
  missing === values.has("--current") ||
  values.size !== (missing ? 1 : 2)
) {
  throw new Error(
    "Usage: plan-worker-publication.mjs (--current <file> | --missing) --candidate <file>",
  );
}
const candidate = await readFile(values.get("--candidate"), "utf8");
const current = missing
  ? null
  : await readFile(values.get("--current"), "utf8");
process.stdout.write(
  `${JSON.stringify(planWorkerPublication(current, candidate))}\n`,
);
