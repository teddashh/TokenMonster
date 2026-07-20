#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";

import {
  planWindowsSquirrelPromotion,
  requireWindowsSquirrelCandidate,
  verifyCurrentWindowsSquirrelChannel,
  verifyPreparedWindowsSquirrelCandidate,
} from "./windows-squirrel-promotion-policy.mjs";

function parseArguments(argv) {
  const values = new Map();
  let missing = false;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--missing") {
      if (missing) throw new Error("--missing may be supplied only once");
      missing = true;
      continue;
    }
    if (
      ![
        "--current",
        "--current-dir",
        "--candidate",
        "--candidate-dir",
      ].includes(name)
    ) {
      throw new Error(`unknown Windows Squirrel promotion argument: ${name}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || values.has(name)) {
      throw new Error(`invalid Windows Squirrel promotion argument: ${name}`);
    }
    values.set(name, value);
    index += 1;
  }
  if (
    !values.has("--candidate") ||
    !values.has("--candidate-dir") ||
    missing === values.has("--current") ||
    missing === values.has("--current-dir") ||
    values.size !== (missing ? 2 : 4)
  ) {
    throw new Error(
      "Usage: plan-windows-squirrel-promotion.mjs (--current <candidate-file> --current-dir <dir> | --missing) --candidate <candidate-file> --candidate-dir <dir>",
    );
  }
  return Object.freeze({ values, missing });
}

async function readCanonicalCandidate(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a physical regular file`);
  }
  const text = await readFile(path, "utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (text !== `${JSON.stringify(value, null, 2)}\n`) {
    throw new Error(`${label} JSON is not canonical`);
  }
  return requireWindowsSquirrelCandidate(value, label);
}

const { values, missing } = parseArguments(process.argv.slice(2));
const candidate = await readCanonicalCandidate(
  values.get("--candidate"),
  "candidate Windows Squirrel state",
);
await verifyPreparedWindowsSquirrelCandidate(
  values.get("--candidate-dir"),
  candidate,
);
const current = missing
  ? null
  : await readCanonicalCandidate(
      values.get("--current"),
      "current Windows Squirrel state",
    );
if (current !== null) {
  await verifyCurrentWindowsSquirrelChannel(
    values.get("--current-dir"),
    current,
  );
}
process.stdout.write(
  `${JSON.stringify(planWindowsSquirrelPromotion(current, candidate))}\n`,
);
