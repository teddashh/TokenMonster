import {
  decideMonotonicReleaseTransition,
  requireWindowsReleaseVersion,
} from "./release-version-contract.mjs";

const RELEASE_KEYS = Object.freeze([
  "contractVersion",
  "platform",
  "version",
  "downloadUrl",
  "sha256",
  "bytes",
]);

function canonicalWorkerRelease(text, label) {
  if (typeof text !== "string" || text.length < 2 || /\r/u.test(text)) {
    throw new TypeError(`${label} is not canonical release JSON`);
  }
  const raw = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (raw.includes("\n")) {
    throw new TypeError(`${label} is not canonical release JSON`);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError(`${label} is not canonical release JSON`);
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(value) !== raw ||
    JSON.stringify(Object.keys(value)) !== JSON.stringify(RELEASE_KEYS) ||
    value.contractVersion !== 1 ||
    value.platform !== "windows-x64" ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1_048_576 ||
    value.bytes > 536_870_912
  ) {
    throw new TypeError(`${label} is not canonical release JSON`);
  }
  const version = requireWindowsReleaseVersion(
    value.version,
    `${label} version`,
  );
  if (
    value.downloadUrl !==
    `https://cdn.ted-h.com/tokenmonster/releases/windows/v${version}/TokenMonsterSetup.exe`
  ) {
    throw new TypeError(`${label} has an invalid release URL`);
  }
  return Object.freeze({ raw, version });
}

export function planWorkerPublication(currentText, candidateText) {
  const candidate = canonicalWorkerRelease(
    candidateText,
    "candidate Worker release",
  );
  const current =
    currentText === null
      ? null
      : canonicalWorkerRelease(currentText, "current Worker release");
  const decision = decideMonotonicReleaseTransition({
    currentVersion: current?.version ?? null,
    candidateVersion: candidate.version,
    currentIdentity: current?.raw ?? null,
    candidateIdentity: candidate.raw,
  });
  return Object.freeze({
    decision,
    currentVersion: current?.version ?? null,
    candidateVersion: candidate.version,
  });
}
