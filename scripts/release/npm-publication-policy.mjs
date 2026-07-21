import {
  decideMonotonicReleaseTransition,
  npmDistTagForReleaseVersion,
  requireWindowsReleaseVersion,
} from "./release-version-contract.mjs";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function registryState(metadata) {
  if (metadata === null) {
    return Object.freeze({ distTags: {}, versions: {} });
  }
  if (
    !isRecord(metadata) ||
    metadata.name !== "tokenmonster" ||
    !isRecord(metadata["dist-tags"]) ||
    !isRecord(metadata.versions)
  ) {
    throw new TypeError("npm registry metadata is malformed");
  }
  return Object.freeze({
    distTags: metadata["dist-tags"],
    versions: metadata.versions,
  });
}

function taggedVersion(state, tag) {
  const value = state.distTags[tag];
  if (value === undefined) return null;
  return requireWindowsReleaseVersion(value, `npm ${tag} version`);
}

function integrityForVersion(state, version, required) {
  const entry = state.versions[version];
  if (entry === undefined && !required) return null;
  if (
    !isRecord(entry) ||
    !isRecord(entry.dist) ||
    typeof entry.dist.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.dist.integrity)
  ) {
    throw new TypeError(`npm ${version} integrity is unavailable or malformed`);
  }
  return entry.dist.integrity;
}

function requireIntegrity(value, label = "candidate npm integrity") {
  if (
    typeof value !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    throw new TypeError(`${label} must be an npm sha512 integrity`);
  }
  return value;
}

export function planNpmPublication(
  metadata,
  candidateVersion,
  candidateIntegrity,
) {
  const candidate = requireWindowsReleaseVersion(
    candidateVersion,
    "npm candidate version",
  );
  const candidateBytes = requireIntegrity(candidateIntegrity);
  const state = registryState(metadata);
  const latestBefore = taggedVersion(state, "latest");
  const nextBefore = taggedVersion(state, "next");
  const targetTag = npmDistTagForReleaseVersion(candidate);
  const currentVersion = targetTag === "latest" ? latestBefore : nextBefore;
  const publishedCandidateIntegrity = integrityForVersion(
    state,
    candidate,
    false,
  );
  if (
    publishedCandidateIntegrity !== null &&
    publishedCandidateIntegrity !== candidateBytes
  ) {
    throw new Error(`npm ${candidate} already exists with different bytes`);
  }
  const currentIntegrity =
    currentVersion === null
      ? null
      : integrityForVersion(state, currentVersion, true);
  const decision = decideMonotonicReleaseTransition({
    currentVersion,
    candidateVersion: candidate,
    currentIdentity: currentIntegrity,
    candidateIdentity: candidateBytes,
  });
  return Object.freeze({
    targetTag,
    decision,
    candidateState: publishedCandidateIntegrity === null ? "missing" : "exact",
    candidateVersion: candidate,
    candidateIntegrity: candidateBytes,
    latestBefore,
    nextBefore,
  });
}

export function requireNpmPublicationPlan(value) {
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value)) !==
      JSON.stringify([
        "targetTag",
        "decision",
        "candidateState",
        "candidateVersion",
        "candidateIntegrity",
        "latestBefore",
        "nextBefore",
      ]) ||
    !["latest", "next"].includes(value.targetTag) ||
    !["advance", "idempotent"].includes(value.decision) ||
    !["missing", "exact"].includes(value.candidateState)
  ) {
    throw new TypeError("npm publication plan is malformed");
  }
  const candidateVersion = requireWindowsReleaseVersion(
    value.candidateVersion,
    "npm plan candidate version",
  );
  if (npmDistTagForReleaseVersion(candidateVersion) !== value.targetTag) {
    throw new TypeError("npm publication plan targets the wrong dist-tag");
  }
  const candidateIntegrity = requireIntegrity(
    value.candidateIntegrity,
    "npm plan candidate integrity",
  );
  for (const [tag, version] of [
    ["latest", value.latestBefore],
    ["next", value.nextBefore],
  ]) {
    if (version !== null) {
      requireWindowsReleaseVersion(version, `npm plan ${tag} version`);
    }
  }
  return Object.freeze({
    targetTag: value.targetTag,
    decision: value.decision,
    candidateState: value.candidateState,
    candidateVersion,
    candidateIntegrity,
    latestBefore: value.latestBefore,
    nextBefore: value.nextBefore,
  });
}

export function verifyNpmPublication(metadata, untrustedPlan) {
  const plan = requireNpmPublicationPlan(untrustedPlan);
  const state = registryState(metadata);
  const latestAfter = taggedVersion(state, "latest");
  const nextAfter = taggedVersion(state, "next");
  const targetAfter = plan.targetTag === "latest" ? latestAfter : nextAfter;
  if (targetAfter !== plan.candidateVersion) {
    throw new Error(
      `npm ${plan.targetTag} does not select ${plan.candidateVersion}`,
    );
  }
  if (
    integrityForVersion(state, plan.candidateVersion, true) !==
    plan.candidateIntegrity
  ) {
    throw new Error("public npm bytes differ from the verified candidate");
  }
  const otherTag = plan.targetTag === "latest" ? "next" : "latest";
  const otherBefore =
    otherTag === "latest" ? plan.latestBefore : plan.nextBefore;
  const otherAfter = otherTag === "latest" ? latestAfter : nextAfter;
  if (otherAfter !== otherBefore) {
    throw new Error(
      `npm ${otherTag} changed during ${plan.targetTag} promotion`,
    );
  }
  return Object.freeze({
    targetTag: plan.targetTag,
    version: plan.candidateVersion,
    latest: latestAfter,
    next: nextAfter,
  });
}
