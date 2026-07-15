import { readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const rootDirectory = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);

const excludedDirectories = new Set([
  ".git",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "playwright-report",
  "test-results",
]);
const textExtensions = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const textBasenames = new Set([
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  "AGENTS.md",
  "LICENSE",
  "README.md",
]);

function isTextFilename(name) {
  const lowerName = name.toLowerCase();
  return (
    textExtensions.has(extname(lowerName)) ||
    textBasenames.has(name) ||
    lowerName === ".env.example" ||
    /^\.env\..+\.example$/u.test(lowerName) ||
    lowerName === ".dev.vars.example" ||
    lowerName === "dockerfile" ||
    lowerName.startsWith("dockerfile.")
  );
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) {
      continue;
    }
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(absolutePath)));
    } else if (
      entry.isFile() &&
      isTextFilename(entry.name)
    ) {
      files.push(absolutePath);
    }
  }
  return files;
}

export async function listRepositoryTextFiles() {
  return (await walk(rootDirectory)).sort();
}

export function repositoryRelativePath(absolutePath) {
  return relative(rootDirectory, absolutePath).replaceAll("\\", "/");
}
