#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  requireNpmPublicationPlan,
  verifyNpmPublication,
} from "./npm-publication-policy.mjs";

const argv = process.argv.slice(2);
const values = new Map();
for (let index = 0; index < argv.length; index += 2) {
  const name = argv[index];
  const value = argv[index + 1];
  if (
    !["--metadata", "--plan", "--tarball"].includes(name) ||
    value === undefined ||
    value.startsWith("--") ||
    values.has(name)
  ) {
    throw new Error(
      "Usage: verify-npm-publication.mjs --metadata <file> --plan <file> --tarball <file>",
    );
  }
  values.set(name, value);
}
if (values.size !== 3) {
  throw new Error(
    "Usage: verify-npm-publication.mjs --metadata <file> --plan <file> --tarball <file>",
  );
}

const [metadataText, planText, tarball] = await Promise.all([
  readFile(values.get("--metadata"), "utf8"),
  readFile(values.get("--plan"), "utf8"),
  readFile(values.get("--tarball")),
]);
const plan = requireNpmPublicationPlan(JSON.parse(planText));
const localIntegrity =
  "sha512-" + createHash("sha512").update(tarball).digest("base64");
if (localIntegrity !== plan.candidateIntegrity) {
  throw new Error("npm publication plan does not identify the local tarball");
}
const verified = verifyNpmPublication(JSON.parse(metadataText), plan);
process.stdout.write(`${JSON.stringify(verified)}\n`);
