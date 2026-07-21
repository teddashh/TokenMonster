#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { requireWindowsReleaseVersion } from "./release-version-contract.mjs";
import {
  requireWindowsSquirrelCandidate,
  verifyPreparedWindowsSquirrelCandidate,
} from "./windows-squirrel-promotion-policy.mjs";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !["--prepared-dir", "--version"].includes(name) ||
      value === undefined ||
      value.startsWith("--") ||
      values.has(name)
    ) {
      throw new Error(
        "Usage: verify-windows-squirrel-candidate.mjs --prepared-dir <dir> --version <version>",
      );
    }
    values.set(name, value);
  }
  if (values.size !== 2) {
    throw new Error(
      "Usage: verify-windows-squirrel-candidate.mjs --prepared-dir <dir> --version <version>",
    );
  }
  return Object.freeze({
    preparedDirectory: resolve(values.get("--prepared-dir")),
    version: requireWindowsReleaseVersion(
      values.get("--version"),
      "Windows Squirrel verification version",
    ),
  });
}

async function readCanonicalCandidate(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Windows Squirrel candidate must be a physical regular file");
  }
  const text = await readFile(path, "utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Windows Squirrel candidate must be valid JSON");
  }
  if (text !== `${JSON.stringify(value, null, 2)}\n`) {
    throw new Error("Windows Squirrel candidate JSON is not canonical");
  }
  return requireWindowsSquirrelCandidate(value);
}

const { preparedDirectory, version } = parseArguments(process.argv.slice(2));
const candidate = await readCanonicalCandidate(
  join(preparedDirectory, "windows-squirrel-candidate-v1.json"),
);
if (candidate.version !== version) {
  throw new Error("Windows Squirrel candidate version differs from the release");
}
const evidence = await verifyPreparedWindowsSquirrelCandidate(
  preparedDirectory,
  candidate,
);
process.stdout.write(`${JSON.stringify(evidence)}\n`);
