import { readFile } from "node:fs/promises";

import {
  ciWindowsReleaseVersionForRunId,
  requireReleaseVersionForSource,
  requireWindowsReleaseVersion,
} from "./release/release-version-contract.mjs";

const cliPackage = JSON.parse(
  await readFile(
    new URL("../packages/cli/package.json", import.meta.url),
    "utf8",
  ),
);
const sourceVersion = requireWindowsReleaseVersion(
  cliPackage.version,
  "CLI source version",
);
if (sourceVersion.includes("-")) {
  throw new Error("CLI source version must be a stable SemVer base");
}

let releaseVersion;
if (process.env.GITHUB_REF_TYPE === "tag") {
  const refName = process.env.GITHUB_REF_NAME;
  if (typeof refName !== "string" || !refName.startsWith("v")) {
    throw new Error("CLI release tags must use the v<version> form.");
  }
  releaseVersion = requireReleaseVersionForSource(
    sourceVersion,
    refName.slice(1),
    "CLI release version",
  );
} else if (process.env.GITHUB_REF_TYPE === "branch") {
  releaseVersion = ciWindowsReleaseVersionForRunId(
    sourceVersion,
    process.env.GITHUB_RUN_ID,
  );
} else {
  throw new Error("GITHUB_REF_TYPE must be branch or tag.");
}

process.stdout.write(releaseVersion);
