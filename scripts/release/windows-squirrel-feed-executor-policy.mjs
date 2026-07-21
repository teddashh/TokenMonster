import { createHash } from "node:crypto";

import {
  createWindowsSquirrelCandidate,
  parseSquirrelReleasesFile,
  planWindowsSquirrelPromotion,
  requireWindowsSquirrelCandidate,
  windowsReleaseVersionFromFullSquirrelPackageName,
  windowsSquirrelChannelForVersion,
} from "./windows-squirrel-promotion-policy.mjs";

const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CHANNELS = new Set(["latest", "next"]);

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(keys)
  );
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireChannel(value) {
  if (typeof value !== "string" || !CHANNELS.has(value)) {
    throw new TypeError("Windows Squirrel channel must be latest or next");
  }
  return value;
}

function requireObservation(value, role, label) {
  if (
    hasExactKeys(value, ["state"]) &&
    (value.state === "missing" || value.state === "unknown")
  ) {
    return value;
  }
  if (
    !hasExactKeys(value, [
      "state",
      "bytes",
      "sha256",
      "sha1",
      "contents",
      "cacheControl",
    ]) ||
    value.state !== "present" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    !(
      value.cacheControl === null ||
      (typeof value.cacheControl === "string" &&
        value.cacheControl.length >= 1 &&
        value.cacheControl.length <= 256 &&
        !/[\r\n]/u.test(value.cacheControl))
    )
  ) {
    throw new TypeError(`${label} observation is malformed`);
  }
  if (role === "releases") {
    if (
      value.sha1 !== null ||
      !(value.contents instanceof Uint8Array) ||
      value.contents.byteLength !== value.bytes ||
      sha256Bytes(value.contents) !== value.sha256
    ) {
      throw new TypeError(`${label} RELEASES observation is malformed`);
    }
  } else if (
    role !== "full-package" ||
    typeof value.sha1 !== "string" ||
    !SHA1_PATTERN.test(value.sha1) ||
    value.contents !== null
  ) {
    throw new TypeError(`${label} full-package observation is malformed`);
  }
  return value;
}

function requireDecisiveObservation(value, role, label) {
  const observation = requireObservation(value, role, label);
  if (observation.state === "unknown") {
    throw new Error(`${label} lookup was unknown`);
  }
  return observation;
}

function requireExactObjectObservation(observation, object, label) {
  const exact = requireDecisiveObservation(observation, object.role, label);
  if (
    exact.state !== "present" ||
    exact.bytes !== object.bytes ||
    exact.sha256 !== object.sha256
  ) {
    throw new Error(`${label} does not contain the exact candidate bytes`);
  }
  return exact;
}

function isExactObjectObservation(observation, object) {
  return (
    observation.state === "present" &&
    observation.bytes === object.bytes &&
    observation.sha256 === object.sha256
  );
}

function candidateObject(candidate, role) {
  const object = candidate.objects.find((entry) => entry.role === role);
  if (object === undefined) {
    throw new TypeError(`Windows Squirrel candidate is missing ${role}`);
  }
  return object;
}

export async function retrieveAuthoritativeWindowsSquirrelChannel({
  channel: untrustedChannel,
  getR2,
}) {
  const channel = requireChannel(untrustedChannel);
  if (typeof getR2 !== "function") {
    throw new TypeError("authoritative R2 reader is required");
  }
  const prefix = `tokenmonster/releases/windows/squirrel/${channel}`;
  const releasesKey = `${prefix}/RELEASES`;
  const releases = requireDecisiveObservation(
    await getR2({ key: releasesKey, role: "releases" }),
    "releases",
    "authoritative current-channel RELEASES",
  );
  if (releases.state === "missing") {
    return Object.freeze({
      state: "missing",
      candidate: null,
      releases: null,
      fullPackage: null,
    });
  }

  const releaseEntry = parseSquirrelReleasesFile(releases.contents);
  const version = windowsReleaseVersionFromFullSquirrelPackageName(
    releaseEntry.fileName,
  );
  if (windowsSquirrelChannelForVersion(version) !== channel) {
    throw new Error(
      "authoritative current-channel RELEASES belongs to the other release channel",
    );
  }
  const fullPackageKey = `${prefix}/${releaseEntry.fileName}`;
  const fullPackage = requireDecisiveObservation(
    await getR2({ key: fullPackageKey, role: "full-package" }),
    "full-package",
    "authoritative current-channel full package",
  );
  if (
    fullPackage.state !== "present" ||
    fullPackage.bytes !== releaseEntry.bytes ||
    fullPackage.sha1 !== releaseEntry.sha1
  ) {
    throw new Error(
      "authoritative current-channel package is missing or differs from RELEASES",
    );
  }
  const candidate = createWindowsSquirrelCandidate({
    version,
    releasesSha256: releases.sha256,
    releasesBytes: releases.bytes,
    fullPackageSha1: fullPackage.sha1,
    fullPackageSha256: fullPackage.sha256,
    fullPackageBytes: fullPackage.bytes,
  });
  return Object.freeze({
    state: "present",
    candidate,
    releases,
    fullPackage,
  });
}

function requireCandidateSources(candidate, value) {
  if (
    !hasExactKeys(value, ["releases", "fullPackage"]) ||
    !hasExactKeys(value.releases, ["source", "observation"]) ||
    !hasExactKeys(value.fullPackage, ["source", "observation"])
  ) {
    throw new TypeError("Windows Squirrel candidate sources are malformed");
  }
  const releasesObject = candidateObject(candidate, "releases");
  const fullPackageObject = candidateObject(candidate, "full-package");
  const releasesObservation = requireExactObjectObservation(
    value.releases.observation,
    releasesObject,
    "local candidate RELEASES",
  );
  const fullPackageObservation = requireExactObjectObservation(
    value.fullPackage.observation,
    fullPackageObject,
    "local candidate full package",
  );
  if (fullPackageObservation.sha1 !== candidate.releaseEntry.sha1) {
    throw new Error("local candidate full package SHA-1 differs from RELEASES");
  }
  const parsed = parseSquirrelReleasesFile(releasesObservation.contents);
  if (
    parsed.fileName !== candidate.releaseEntry.fileName ||
    parsed.bytes !== candidate.releaseEntry.bytes ||
    parsed.sha1 !== candidate.releaseEntry.sha1
  ) {
    throw new Error("local candidate RELEASES entry differs from its candidate");
  }
  return Object.freeze({
    releases: Object.freeze({
      source: value.releases.source,
      observation: releasesObservation,
    }),
    fullPackage: Object.freeze({
      source: value.fullPackage.source,
      observation: fullPackageObservation,
    }),
  });
}

function sourceForRole(sources, role) {
  return role === "releases" ? sources.releases : sources.fullPackage;
}

function requireUnchangedCurrentChannel(initial, repeated, label) {
  if (
    initial.state !== repeated.state ||
    JSON.stringify(initial.candidate) !== JSON.stringify(repeated.candidate)
  ) {
    throw new Error(`${label} changed during Squirrel promotion`);
  }
}

async function requireR2Exact(getR2, object, key, label) {
  return requireExactObjectObservation(
    await getR2({ key, role: object.role }),
    object,
    label,
  );
}

async function createOrVerifyExact({
  getR2,
  putR2,
  getPublic,
  object,
  destinationKey,
  source,
  label,
  cacheControl,
}) {
  const before = requireDecisiveObservation(
    await getR2({ key: destinationKey, role: object.role }),
    object.role,
    `${label} before-write`,
  );
  let outcome = "verified";
  if (before.state === "present") {
    requireExactObjectObservation(before, object, `${label} existing object`);
    const publicBefore = requireObservation(
      await getPublic({ key: destinationKey, role: object.role }),
      object.role,
      `${label} public metadata probe`,
    );
    if (
      publicBefore.state !== "present" ||
      publicBefore.bytes !== object.bytes ||
      publicBefore.sha256 !== object.sha256 ||
      publicBefore.cacheControl !== cacheControl
    ) {
      // Authoritative Wrangler GET proves bytes but does not expose HTTP
      // metadata. The protected single-writer lane may rewrite only those
      // already-exact bytes to repair explicit cache metadata. Byte drift was
      // rejected above and is never overwritten.
      await putR2({
        key: destinationKey,
        role: object.role,
        contentType: object.contentType,
        cacheControl,
        source: source.source,
        expectedSha256: object.sha256,
        expectedSha1:
          object.role === "full-package" ? source.observation.sha1 : null,
        expectedBytes: object.bytes,
      });
      outcome = "metadata-repaired";
    }
  } else {
    await putR2({
      key: destinationKey,
      role: object.role,
      contentType: object.contentType,
      cacheControl,
      source: source.source,
      expectedSha256: object.sha256,
      expectedSha1:
        object.role === "full-package" ? source.observation.sha1 : null,
      expectedBytes: object.bytes,
    });
    outcome = "created";
  }
  await requireR2Exact(getR2, object, destinationKey, `${label} readback`);
  return outcome;
}

async function requirePublicExact({
  getPublic,
  object,
  key,
  label,
  attempts,
  wait,
  expectedCacheControl,
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const observation = requireObservation(
      await getPublic({ key, role: object.role }),
      object.role,
      label,
    );
    if (
      observation.state === "present" &&
      observation.bytes === object.bytes &&
      observation.sha256 === object.sha256 &&
      observation.cacheControl === expectedCacheControl
    ) {
      return observation;
    }
    if (attempt < attempts) await wait();
  }
  throw new Error(`${label} did not converge to the exact candidate bytes`);
}

async function requirePublicMissing({
  getPublic,
  key,
  role,
  label,
  attempts,
  wait,
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const observation = requireObservation(
      await getPublic({ key, role }),
      role,
      label,
    );
    if (observation.state === "missing") return;
    if (attempt < attempts) await wait();
  }
  throw new Error(`${label} did not converge to exact missing state`);
}

async function rollbackMetadata({
  current,
  candidateReleasesObject,
  getR2,
  putR2,
  deleteR2,
  getPublic,
  attempts,
  wait,
}) {
  const channelKey = candidateReleasesObject.channelKey;
  await requireR2Exact(
    getR2,
    candidateReleasesObject,
    channelKey,
    "channel RELEASES before rollback",
  );
  if (current.state === "missing") {
    try {
      await deleteR2({ key: channelKey, role: "releases" });
    } catch {
      // A transport failure may arrive after R2 committed the delete. Never
      // infer either outcome from the command response; the decisive GET and
      // public convergence checks below are the authority.
    }
    const after = requireDecisiveObservation(
      await getR2({ key: channelKey, role: "releases" }),
      "releases",
      "channel RELEASES rollback readback",
    );
    if (after.state !== "missing") {
      throw new Error("first-publication RELEASES rollback did not delete metadata");
    }
    await requirePublicMissing({
      getPublic,
      key: channelKey,
      role: "releases",
      label: "public first-publication RELEASES rollback",
      attempts,
      wait,
    });
    return "deleted-candidate-metadata";
  }
  const priorObject = candidateObject(current.candidate, "releases");
  try {
    await putR2({
      key: channelKey,
      role: "releases",
      contentType: priorObject.contentType,
      cacheControl: priorObject.channelCacheControl,
      source: Object.freeze({
        kind: "inline-releases",
        contents: current.releases.contents,
      }),
      expectedSha256: priorObject.sha256,
      expectedSha1: null,
      expectedBytes: priorObject.bytes,
    });
  } catch {
    // As above, response loss is not evidence that the rollback failed. The
    // authoritative and public exact reads below decide the result.
  }
  await requireR2Exact(
    getR2,
    priorObject,
    channelKey,
    "rolled-back channel RELEASES",
  );
  await requirePublicExact({
    getPublic,
    object: priorObject,
    key: channelKey,
    label: "public rolled-back channel RELEASES",
    attempts,
    wait,
    expectedCacheControl: priorObject.channelCacheControl,
  });
  return "restored-prior-metadata";
}

async function recoverMetadataFailure({
  current,
  candidateReleasesObject,
  getR2,
  putR2,
  deleteR2,
  getPublic,
  attempts,
  wait,
}) {
  const channelKey = candidateReleasesObject.channelKey;
  const observed = requireDecisiveObservation(
    await getR2({ key: channelKey, role: "releases" }),
    "releases",
    "channel RELEASES after uncertain commit",
  );
  if (observed.state === "missing") {
    if (current.state !== "missing") {
      throw new Error("channel RELEASES disappeared during uncertain commit");
    }
    await requirePublicMissing({
      getPublic,
      key: channelKey,
      role: "releases",
      label: "public unchanged first-publication RELEASES",
      attempts,
      wait,
    });
    return "first-publication-metadata-remained-missing";
  }
  if (isExactObjectObservation(observed, candidateReleasesObject)) {
    return rollbackMetadata({
      current,
      candidateReleasesObject,
      getR2,
      putR2,
      deleteR2,
      getPublic,
      attempts,
      wait,
    });
  }
  if (current.state === "present") {
    const priorObject = candidateObject(current.candidate, "releases");
    if (isExactObjectObservation(observed, priorObject)) {
      await requirePublicExact({
        getPublic,
        object: priorObject,
        key: channelKey,
        label: "public unchanged prior channel RELEASES",
        attempts,
        wait,
        expectedCacheControl: priorObject.channelCacheControl,
      });
      return "prior-metadata-remained-exact";
    }
  }
  throw new Error("channel RELEASES entered an unrecognized state");
}

export async function executeWindowsSquirrelPromotion({
  candidate: untrustedCandidate,
  candidateSources: untrustedSources,
  getR2,
  putR2,
  deleteR2,
  getPublic,
  publicReadAttempts = 6,
  wait = () => Promise.resolve(),
  now = Date.now,
  executionDeadline = Number.POSITIVE_INFINITY,
  minimumMetadataWindowMs = 30 * 60 * 1_000,
}) {
  const candidate = requireWindowsSquirrelCandidate(untrustedCandidate);
  if (
    typeof getR2 !== "function" ||
    typeof putR2 !== "function" ||
    typeof deleteR2 !== "function" ||
    typeof getPublic !== "function" ||
    typeof wait !== "function" ||
    typeof now !== "function" ||
    !Number.isSafeInteger(publicReadAttempts) ||
    publicReadAttempts < 1 ||
    publicReadAttempts > 12 ||
    !(
      executionDeadline === Number.POSITIVE_INFINITY ||
      (Number.isSafeInteger(executionDeadline) && executionDeadline > 0)
    ) ||
    !Number.isSafeInteger(minimumMetadataWindowMs) ||
    minimumMetadataWindowMs < 1
  ) {
    throw new TypeError("Windows Squirrel executor dependencies are malformed");
  }
  const sources = requireCandidateSources(candidate, untrustedSources);
  const current = await retrieveAuthoritativeWindowsSquirrelChannel({
    channel: candidate.channel,
    getR2,
  });
  const plan = planWindowsSquirrelPromotion(current.candidate, candidate);
  const operations = [];
  if (plan.decision === "advance" && current.state === "present") {
    for (const object of current.candidate.objects) {
      await requirePublicExact({
        getPublic,
        object,
        key: object.channelKey,
        label: `public current channel ${object.role}`,
        attempts: publicReadAttempts,
        wait,
        expectedCacheControl: object.channelCacheControl,
      });
    }
    operations.push("current-channel-r2-and-public-verified");
  }

  for (const role of ["full-package", "releases"]) {
    const object = candidateObject(candidate, role);
    const result = await createOrVerifyExact({
      getR2,
      putR2,
      getPublic,
      object,
      destinationKey: object.immutableKey,
      source: sourceForRole(sources, role),
      label: `immutable ${role}`,
      cacheControl: object.immutableCacheControl,
    });
    await requirePublicExact({
      getPublic,
      object,
      key: object.immutableKey,
      label: `public immutable ${role}`,
      attempts: publicReadAttempts,
      wait,
      expectedCacheControl: object.immutableCacheControl,
    });
    operations.push(`immutable-${role}-${result}`);
  }

  const fullPackageObject = candidateObject(candidate, "full-package");
  const releasesObject = candidateObject(candidate, "releases");
  if (plan.decision === "advance") {
    requireUnchangedCurrentChannel(
      current,
      await retrieveAuthoritativeWindowsSquirrelChannel({
        channel: candidate.channel,
        getR2,
      }),
      "authoritative current channel before package write",
    );
    const packageResult = await createOrVerifyExact({
      getR2,
      putR2,
      getPublic,
      object: fullPackageObject,
      destinationKey: fullPackageObject.channelKey,
      source: sources.fullPackage,
      label: "channel full-package",
      cacheControl: fullPackageObject.channelCacheControl,
    });
    await requirePublicExact({
      getPublic,
      object: fullPackageObject,
      key: fullPackageObject.channelKey,
      label: "public channel full-package before metadata commit",
      attempts: publicReadAttempts,
      wait,
      expectedCacheControl: fullPackageObject.channelCacheControl,
    });
    operations.push(`channel-full-package-${packageResult}`);

    requireUnchangedCurrentChannel(
      current,
      await retrieveAuthoritativeWindowsSquirrelChannel({
        channel: candidate.channel,
        getR2,
      }),
      "authoritative current channel before metadata commit",
    );

    if (executionDeadline - now() < minimumMetadataWindowMs) {
      throw new Error(
        "insufficient aggregate deadline remains for Squirrel metadata commit",
      );
    }
    try {
      await putR2({
        key: releasesObject.channelKey,
        role: "releases",
        contentType: releasesObject.contentType,
        cacheControl: releasesObject.channelCacheControl,
        source: sources.releases.source,
        expectedSha256: releasesObject.sha256,
        expectedSha1: null,
        expectedBytes: releasesObject.bytes,
      });
      operations.push("channel-releases-commit-attempt-returned");
      await requireR2Exact(
        getR2,
        releasesObject,
        releasesObject.channelKey,
        "channel RELEASES commit readback",
      );
      await requirePublicExact({
        getPublic,
        object: releasesObject,
        key: releasesObject.channelKey,
        label: "public channel RELEASES commit",
        attempts: publicReadAttempts,
        wait,
        expectedCacheControl: releasesObject.channelCacheControl,
      });
    } catch (error) {
      try {
        const recovery = await recoverMetadataFailure({
          current,
          candidateReleasesObject: releasesObject,
          getR2,
          putR2,
          deleteR2,
          getPublic,
          attempts: publicReadAttempts,
          wait,
        });
        operations.push(`recovery-${recovery}`);
      } catch {
        throw new Error(
          "Squirrel channel metadata commit was uncertain and exact recovery also failed",
          { cause: error },
        );
      }
      throw new Error(
        "Squirrel channel metadata commit failed; exact no-change or rollback recovery completed",
        { cause: error },
      );
    }
    operations.push("channel-releases-r2-and-public-verified");

    if (
      current.state === "present" &&
      candidateObject(current.candidate, "full-package").channelKey !==
        fullPackageObject.channelKey
    ) {
      // A client may have fetched the prior RELEASES immediately before the
      // commit. Keep its version-named package available. A separate,
      // retention-aware GC policy may remove it only after the client overlap
      // window; promotion itself never guesses that window has elapsed.
      operations.push("prior-channel-full-package-retained-for-client-overlap");
    }
  } else {
    for (const object of [fullPackageObject, releasesObject]) {
      const result = await createOrVerifyExact({
        getR2,
        putR2,
        getPublic,
        object,
        destinationKey: object.channelKey,
        source: sourceForRole(sources, object.role),
        label: `idempotent channel ${object.role}`,
        cacheControl: object.channelCacheControl,
      });
      operations.push(`idempotent-channel-${object.role}-${result}`);
    }
  }

  for (const object of [fullPackageObject, releasesObject]) {
    await requireR2Exact(
      getR2,
      object,
      object.channelKey,
      `final channel ${object.role}`,
    );
    await requirePublicExact({
      getPublic,
      object,
      key: object.channelKey,
      label: `final public channel ${object.role}`,
      attempts: publicReadAttempts,
      wait,
      expectedCacheControl: object.channelCacheControl,
    });
  }
  operations.push("final-channel-r2-and-public-verified");

  return Object.freeze({
    squirrelFeedPromotionEvidenceContractVersion: 1,
    decision: plan.decision,
    channel: candidate.channel,
    currentState: current.state,
    currentVersion: current.candidate?.version ?? null,
    candidateVersion: candidate.version,
    candidateIdentitySha256: plan.candidateIdentitySha256,
    verification: "exact-r2-and-public-cdn-readback",
    operations: Object.freeze(operations),
  });
}
