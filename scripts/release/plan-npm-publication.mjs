#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { planNpmPublication } from "./npm-publication-policy.mjs";

function argumentsFrom(argv) {
  const values = new Map();
  let missing = false;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--missing") {
      if (missing) throw new Error("--missing may be supplied only once");
      missing = true;
      continue;
    }
    if (!["--metadata", "--tarball", "--version"].includes(name)) {
      throw new Error(`unknown npm publication argument: ${name}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || values.has(name)) {
      throw new Error(`invalid npm publication argument: ${name}`);
    }
    values.set(name, value);
    index += 1;
  }
  if (
    values.size !== (missing ? 2 : 3) ||
    missing === values.has("--metadata") ||
    !values.has("--tarball") ||
    !values.has("--version")
  ) {
    throw new Error(
      "Usage: plan-npm-publication.mjs (--metadata <file> | --missing) --tarball <file> --version <version>",
    );
  }
  return { values, missing };
}

const { values, missing } = argumentsFrom(process.argv.slice(2));
const tarball = await readFile(values.get("--tarball"));
const candidateIntegrity =
  "sha512-" + createHash("sha512").update(tarball).digest("base64");
const metadata = missing
  ? null
  : JSON.parse(await readFile(values.get("--metadata"), "utf8"));
const plan = planNpmPublication(
  metadata,
  values.get("--version"),
  candidateIntegrity,
);
process.stdout.write(`${JSON.stringify(plan)}\n`);
