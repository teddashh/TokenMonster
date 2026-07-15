import { readFile } from "node:fs/promises";

import {
  listRepositoryTextFiles,
  repositoryRelativePath,
} from "./repository-files.mjs";

const secretPatterns = [
  ["private key", /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/u],
  ["Cloudflare API token", /\b(?:CLOUDFLARE|CF)_API_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}\b/u],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}\b/u],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/u],
  ["Google OAuth client secret", /\bGOCSPX-[0-9A-Za-z_-]{20,}\b/u],
  ["JSON Web Token", /\beyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{16,}\b/u],
  ["npm access token", /\bnpm_[A-Za-z0-9]{36}\b/u],
  ["OpenAI-style API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u],
];

const failures = [];
for (const file of await listRepositoryTextFiles()) {
  const contents = await readFile(file, "utf8");
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(contents)) {
      failures.push(`${repositoryRelativePath(file)}: possible ${label}`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`High-confidence secret scan failed:\n${failures.join("\n")}`);
}
