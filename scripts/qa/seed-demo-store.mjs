#!/usr/bin/env node

// Seeds a demo progression store so character unlocks can be exercised on a
// machine without real TokenTracker usage. Local QA only — writes the same
// file the CLI maintains, and refuses to touch an existing store.
//
// Works from two places:
//   - a repo clone (resolves the built packages/characters workspace)
//   - a directory where the release tarball was npm-installed (run it with
//     that directory as the working directory; also shipped as a release
//     asset for exactly this case)

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const storePath = join(homedir(), ".tokenmonster", "progression-v1.json");
if (existsSync(storePath)) {
  console.error(`Refusing to overwrite an existing progression store:`);
  console.error(`  ${storePath}`);
  console.error(
    "This machine already has TokenMonster state. Delete ~/.tokenmonster first if you really want a demo reset.",
  );
  process.exit(1);
}

function charactersDistUrl(file) {
  const candidates = [
    new URL(`../../packages/characters/dist/${file}`, import.meta.url),
    pathToFileURL(
      join(
        process.cwd(),
        "node_modules",
        "tokenmonster",
        "node_modules",
        "@tokenmonster",
        "characters",
        "dist",
        file,
      ),
    ),
  ];
  const found = candidates.find((candidate) =>
    existsSync(fileURLToPath(candidate)),
  );
  if (found === undefined) {
    console.error(
      "Could not find the built @tokenmonster/characters package. Run this from a built repo clone or from the directory where the release tarball was npm-installed.",
    );
    process.exit(1);
  }
  return found;
}

const storeModule = await import(charactersDistUrl("progression-store.js"));
const progressionModule = await import(charactersDistUrl("progression.js"));

const DAYS = 8;
const DAY_MS = 86_400_000;
const now = new Date();
const buckets = [...Array(DAYS)].map((_, index) => ({
  utcDate: new Date(now.getTime() - (DAYS - 1 - index) * DAY_MS)
    .toISOString()
    .slice(0, 10),
  providerTotals: {
    openai: 1_000_000,
    anthropic: 700_000,
    google: 300_000,
    xai: 150_000,
  },
}));

const empty = storeModule.createEmptyLocalProgressionStore();
const candidate = storeModule.mergeDailyProviderBuckets(empty, buckets);
await storeModule.saveLocalProgressionStore(candidate, { path: storePath });

const state = progressionModule.evaluateProgression({
  schemaVersion: "1",
  evaluatedAt: now.toISOString(),
  evaluationUtcDate: now.toISOString().slice(0, 10),
  dailyProviderBuckets: candidate.lifetime.dailyProviderBuckets,
  traitIds: [],
  persistedUnlockedAt: {},
  selection: candidate.selection,
});
const unlocked = state.characters
  .filter((character) => character.unlocked)
  .map((character) => character.characterId);

console.log(`Demo store written: ${storePath}`);
console.log(`Seeded ${DAYS} days of demo usage across 4 provider families.`);
console.log(`Characters unlocked on next launch: ${unlocked.join(", ")}`);
console.log("Reset everything with: delete the ~/.tokenmonster directory.");
