import {
  ciReleaseVersionForRunId,
  requireReleaseVersion,
} from "../apps/companion/packaging/release-policy.mjs";

const refType = process.env.GITHUB_REF_TYPE;
let releaseVersion;
if (refType === "tag") {
  const refName = process.env.GITHUB_REF_NAME;
  if (typeof refName !== "string" || !refName.startsWith("v")) {
    throw new Error("Desktop release tags must use the v<version> form.");
  }
  releaseVersion = requireReleaseVersion({
    TOKENMONSTER_RELEASE_VERSION: refName.slice(1),
  });
} else if (refType === "branch") {
  releaseVersion = ciReleaseVersionForRunId(process.env.GITHUB_RUN_ID);
} else {
  throw new Error("GITHUB_REF_TYPE must be branch or tag.");
}

process.stdout.write(releaseVersion);
