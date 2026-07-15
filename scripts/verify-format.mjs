import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import {
  listRepositoryTextFiles,
  repositoryRelativePath,
} from "./repository-files.mjs";

const failures = [];
for (const file of await listRepositoryTextFiles()) {
  const path = repositoryRelativePath(file);
  const contents = await readFile(file, "utf8");
  if (contents.includes("\r")) {
    failures.push(`${path}: must use LF line endings`);
  }
  if (!contents.endsWith("\n")) {
    failures.push(`${path}: must end with a newline`);
  }
  if (contents.split("\n").some((line) => /[\t ]+$/u.test(line))) {
    failures.push(`${path}: contains trailing whitespace`);
  }
  if (extname(file).toLowerCase() === ".json") {
    try {
      JSON.parse(contents);
    } catch {
      failures.push(`${path}: is not valid JSON`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Repository format check failed:\n${failures.join("\n")}`);
}
