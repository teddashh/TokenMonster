// Desktop-side staging for the eight reviewed embedded starter objects. The
// packaging wrapper acquires the pinned source pack here (network or an exact
// local copy), and the Electron packager's afterCopy hook then re-verifies and
// copies the staged bytes into the app resources as an extraResource.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { acquireEmbeddedStarterObjects } from "./embedded-starter-pack.mjs";

export const COMPANION_EMBEDDED_STARTER_STAGING_NAME =
  "embedded-starter-staging";

/**
 * Stage the verified starter objects into `<stagingDirectory>/objects/`.
 * The directory is recreated from scratch so stale bytes can never leak into
 * a packaged build.
 */
export async function stageCompanionEmbeddedStarterAssets({
  stagingDirectory,
  localPackPath = null,
}) {
  const objects = await acquireEmbeddedStarterObjects(localPackPath);
  await rm(stagingDirectory, { force: true, recursive: true });
  for (const { asset, contents } of objects) {
    const destination = join(stagingDirectory, ...asset.objectPath.split("/"));
    await mkdir(dirname(destination), { mode: 0o755, recursive: true });
    await writeFile(destination, contents, { flag: "wx", mode: 0o644 });
  }
}
