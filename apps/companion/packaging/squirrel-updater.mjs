// @ts-check

import { createHash } from "node:crypto";
import { copyFile, cp, lstat, open, readdir, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const reviewedDirectory = fileURLToPath(
  new URL("squirrel-windows/", import.meta.url),
);
const reviewedBinaryPath = join(reviewedDirectory, "Squirrel.exe");
const reviewPath = join(reviewedDirectory, "integration-review.json");
const vendorInventoryPath = join(
  reviewedDirectory,
  "electron-winstaller-5.4.4-vendor-hashes.txt",
);
const confirmationProvenancePath = join(
  reviewedDirectory,
  "provenance",
  "confirmation-run-29794447787.json",
);
const mergeInputReceiptPath = join(
  reviewedDirectory,
  "provenance",
  "merge-input-hashes.txt",
);
const dependencyReceiptPath = join(
  reviewedDirectory,
  "provenance",
  "nuget-content-hashes.txt",
);
const sourceTestDependencyReceiptPath = join(
  reviewedDirectory,
  "provenance",
  "source-test-nuget-content-hashes.txt",
);
const xdtLicensePath = join(
  reviewedDirectory,
  "licenses",
  "MICROSOFT-WEB-XDT-LICENSE.txt",
);
const xdtAttributionPath = join(
  reviewedDirectory,
  "licenses",
  "MICROSOFT-WEB-XDT-ATTRIBUTION.txt",
);
const ELECTRON_WINSTALLER_VERSION = "5.4.4";
const EXPECTED_VENDOR_FILE_COUNT = 33;
const MAX_VENDOR_FILE_BYTES = 16 * 1024 * 1024;
const MAX_VENDOR_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_POLICY_FILE_BYTES = 32 * 1024;
const MAX_SQUIRREL_RELEASIFY_LOG_BYTES = 4 * 1024 * 1024;
const SQUIRREL_RELEASIFY_LOG = "Squirrel-Releasify.log";
const EXPECTED_VENDOR_INVENTORY_SHA256 =
  "a7cacc76777553878f6f873c8471fe5e3b9242cb4e557f83cf7227eccbaf3919";

export const REVIEWED_SQUIRREL_UPDATER = Object.freeze({
  bytes: 1_841_664,
  sha256: "83b754a9b24742675678c5d8fa024a8140c2d18eb640116a87a364f0a897388a",
  sourceBaseCommit: "eef37460aef77b2f9de8cd2237c1e55b344a6554",
  sourceFixCommit: "c98244936f6876b080366417301268058028a53c",
  sourceFixTree: "0a1ebfa90cea6f8037907134d53562a26c6bb4c3",
  dependencyInventorySha256:
    "9ab90cdb2131c34d8c871c2eba37edc7cbc12d63e2abdfcea4306e4cea367b23",
  sourceTestDependencyInventorySha256:
    "f7fe9ed4bb26e0e812d86a8a04971ac6f71824e3dea483fab0ec21462267e4a6",
  mergeInputInventorySha256:
    "9086ab285b0959e8bbbd2e797b53865d80793468bff6d3aa8f76a9b4e88d03d2",
  xdtLicenseSha256:
    "43070e2d4e532684de521b885f385d0841030efa2b1a20bafb76133a5e1379c1",
  xdtAttributionSha256:
    "5942a1e712f375fbc36e2ce62bd12b930d6d70c9d9ec74caea35d7ec48fbe1a2",
  integrationStatus: "reviewed-internal-candidate",
  publicReleaseStatus:
    "blocked-pending-redistribution-and-native-install-review",
});

const STOCK_SQUIRREL_UPDATER = Object.freeze({
  bytes: 1_899_520,
  sha256: "76359cd4b0349a83337b941332ad042c90351c2bb0a4628307740324c97984cc",
});

/**
 * @param {string} left
 * @param {string} right
 */
function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * @param {import("node:fs").BigIntStats} left
 * @param {import("node:fs").BigIntStats} right
 */
function samePhysicalFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/**
 * @param {string} path
 * @param {string} label
 * @param {number} maximumBytes
 */
async function hashPhysicalFile(path, label, maximumBytes) {
  const result = await inspectPhysicalFile(path, label, maximumBytes, false);
  return result.binding;
}

/**
 * @param {string} path
 * @param {string} label
 * @param {number} maximumBytes
 * @param {boolean} captureContents
 */
async function inspectPhysicalFile(path, label, maximumBytes, captureContents) {
  const pathBefore = await lstat(path, { bigint: true });
  if (
    !pathBefore.isFile() ||
    pathBefore.isSymbolicLink() ||
    pathBefore.size < 1n ||
    pathBefore.size > BigInt(maximumBytes)
  ) {
    throw new Error(`${label} is not a bounded physical file.`);
  }
  const handle = await open(path, "r");
  try {
    const openedBefore = await handle.stat({ bigint: true });
    if (!openedBefore.isFile() || !samePhysicalFile(pathBefore, openedBefore)) {
      throw new Error(`${label} changed before it could be opened.`);
    }
    const hash = createHash("sha256");
    const chunks = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      end: maximumBytes,
      start: 0,
    })) {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        throw new Error(`${label} exceeded its byte bound while being read.`);
      }
      hash.update(chunk);
      if (captureContents) chunks.push(chunk);
    }
    const [openedAfter, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (
      bytes !== Number(openedBefore.size) ||
      !samePhysicalFile(openedBefore, openedAfter) ||
      !samePhysicalFile(openedBefore, pathAfter)
    ) {
      throw new Error(`${label} changed while it was being verified.`);
    }
    return Object.freeze({
      binding: Object.freeze({
        bytes,
        sha256: hash.digest("hex"),
      }),
      contents: captureContents ? Buffer.concat(chunks, bytes) : null,
    });
  } finally {
    await handle.close();
  }
}

/**
 * @param {string} path
 * @param {string} label
 */
async function readPolicyFile(path, label) {
  const { binding, contents: rawContents } = await inspectPhysicalFile(
    path,
    label,
    MAX_POLICY_FILE_BYTES,
    true,
  );
  if (rawContents === null) {
    throw new Error(`${label} was not captured during verification.`);
  }
  const contents = rawContents.toString("utf8");
  if (
    Buffer.byteLength(contents, "utf8") !== binding.bytes ||
    !Buffer.from(contents, "utf8").equals(rawContents) ||
    contents.includes("\0")
  ) {
    throw new Error(`${label} is not canonical bounded UTF-8 text.`);
  }
  return Object.freeze({ binding, contents });
}

/**
 * @param {unknown} value
 * @param {readonly string[]} keys
 */
function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort(compareAscii)) ===
      JSON.stringify([...keys].sort(compareAscii))
  );
}

/** @param {unknown} confirmation */
function hasExactConfirmationKeys(confirmation) {
  return hasExactKeys(confirmation, [
    "artifactArchiveSha256",
    "artifactId",
    "artifactProvenanceSha256",
    "workflowCommit",
    "workflowRunId",
  ]);
}

/**
 * Reconstruct the Windows artifact bytes from the repository's normalized LF
 * text. PowerShell emitted the JSON closing brace with LF while its body used
 * CRLF; the two inventory receipts use CRLF throughout.
 *
 * @param {string} contents
 * @param {boolean} finalLineFeedOnly
 */
function windowsArtifactTextSha256(contents, finalLineFeedOnly) {
  const lastLineFeed = contents.lastIndexOf("\n");
  const artifactText = finalLineFeedOnly
    ? `${contents.slice(0, lastLineFeed).replaceAll("\n", "\r\n")}${contents.slice(lastLineFeed)}`
    : contents.replaceAll("\n", "\r\n");
  return createHash("sha256").update(artifactText, "utf8").digest("hex");
}

/** @param {string} contents */
function finalLineFeedStrippedSha256(contents) {
  if (
    !contents.endsWith("\n") ||
    contents.endsWith("\n\n") ||
    contents.includes("\r")
  ) {
    return "";
  }
  return createHash("sha256")
    .update(contents.slice(0, -1), "utf8")
    .digest("hex");
}

async function verifyNormalizedBuildEvidence() {
  const [
    provenance,
    mergeInputs,
    dependencies,
    sourceTestDependencies,
    xdtLicense,
    xdtAttribution,
  ] = await Promise.all([
    readPolicyFile(
      confirmationProvenancePath,
      "Squirrel confirmation provenance",
    ),
    readPolicyFile(mergeInputReceiptPath, "Squirrel merge-input receipt"),
    readPolicyFile(dependencyReceiptPath, "Squirrel dependency receipt"),
    readPolicyFile(
      sourceTestDependencyReceiptPath,
      "Squirrel source-test dependency receipt",
    ),
    readPolicyFile(xdtLicensePath, "Microsoft.Web.Xdt license"),
    hashPhysicalFile(
      xdtAttributionPath,
      "Microsoft.Web.Xdt attribution",
      MAX_POLICY_FILE_BYTES,
    ),
  ]);
  const parsedProvenance = JSON.parse(provenance.contents);
  if (
    windowsArtifactTextSha256(provenance.contents, true) !==
      "153c1cf52c298f1da410b8cadfc16e309586214b2995f9ecfee22ce29acfeaf2" ||
    windowsArtifactTextSha256(mergeInputs.contents, false) !==
      REVIEWED_SQUIRREL_UPDATER.mergeInputInventorySha256 ||
    windowsArtifactTextSha256(dependencies.contents, false) !==
      REVIEWED_SQUIRREL_UPDATER.dependencyInventorySha256 ||
    windowsArtifactTextSha256(sourceTestDependencies.contents, false) !==
      REVIEWED_SQUIRREL_UPDATER.sourceTestDependencyInventorySha256 ||
    finalLineFeedStrippedSha256(xdtLicense.contents) !==
      REVIEWED_SQUIRREL_UPDATER.xdtLicenseSha256 ||
    xdtAttribution.sha256 !== REVIEWED_SQUIRREL_UPDATER.xdtAttributionSha256 ||
    parsedProvenance?.candidateOnly !== true ||
    parsedProvenance?.workflowRunId !== "29794447787" ||
    parsedProvenance?.binarySha256 !== REVIEWED_SQUIRREL_UPDATER.sha256 ||
    parsedProvenance?.binaryBytes !== REVIEWED_SQUIRREL_UPDATER.bytes
  ) {
    throw new Error(
      "Normalized Squirrel build evidence differs from the artifact.",
    );
  }
}

/**
 * @param {string} directory
 * @param {string} label
 */
async function inventoryFlatVendorDirectory(directory, label) {
  const directoryBefore = await lstat(directory, { bigint: true });
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
    throw new Error(`${label} is not a physical directory.`);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    entries.length !== EXPECTED_VENDOR_FILE_COUNT ||
    entries.some(
      (entry) =>
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.name),
    )
  ) {
    throw new Error(`${label} has an unexpected file inventory.`);
  }
  const lines = [];
  let totalBytes = 0;
  for (const entry of entries.sort((left, right) =>
    compareAscii(left.name, right.name),
  )) {
    const binding = await hashPhysicalFile(
      join(directory, entry.name),
      `${label}/${entry.name}`,
      MAX_VENDOR_FILE_BYTES,
    );
    totalBytes += binding.bytes;
    if (totalBytes > MAX_VENDOR_TOTAL_BYTES) {
      throw new Error(`${label} exceeds its reviewed byte budget.`);
    }
    lines.push(`${binding.sha256} ${binding.bytes} ${entry.name}`);
  }
  const entriesAfter = (await readdir(directory)).sort(compareAscii);
  const directoryAfter = await lstat(directory, { bigint: true });
  if (
    JSON.stringify(entriesAfter) !==
      JSON.stringify(entries.map((entry) => entry.name).sort(compareAscii)) ||
    !samePhysicalFile(directoryBefore, directoryAfter)
  ) {
    throw new Error(`${label} changed while it was being inventoried.`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * electron-winstaller's install script replaces the generic 7z.exe/7z.dll
 * aliases with the copies for the npm install host. The committed receipt is
 * still the canonical authority: it binds both supported architecture pairs
 * and records the x64 pair in the generic aliases. Project only those two
 * aliases after the receipt itself has been authenticated.
 *
 * @param {string} canonicalInventory
 * @param {unknown} architecture
 */
export function projectElectronWinstallerVendorInventoryForArchitecture(
  canonicalInventory,
  architecture,
) {
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new Error(
      "electron-winstaller vendor aliases support only x64 or arm64 hosts.",
    );
  }
  const lines =
    typeof canonicalInventory === "string" &&
    canonicalInventory.endsWith("\n") &&
    !canonicalInventory.endsWith("\n\n") &&
    !canonicalInventory.includes("\r")
      ? canonicalInventory.slice(0, -1).split("\n")
      : [];
  if (
    lines.length !== EXPECTED_VENDOR_FILE_COUNT ||
    lines.some(
      (line) =>
        !/^[a-f0-9]{64} [1-9][0-9]* [A-Za-z0-9][A-Za-z0-9._-]*$/u.test(line),
    )
  ) {
    throw new Error(
      "Canonical electron-winstaller vendor inventory is malformed.",
    );
  }
  const entries = new Map();
  for (const line of lines) {
    const name = line.slice(line.lastIndexOf(" ") + 1);
    if (entries.has(name)) {
      throw new Error(
        "Canonical electron-winstaller vendor inventory has duplicate names.",
      );
    }
    entries.set(name, line.slice(0, line.lastIndexOf(" ")));
  }
  const projectedAliases = new Map();
  for (const extension of ["dll", "exe"]) {
    const aliasName = `7z.${extension}`;
    const canonicalName = `7z-x64.${extension}`;
    const architectureName = `7z-${architecture}.${extension}`;
    const aliasBinding = entries.get(aliasName);
    const canonicalBinding = entries.get(canonicalName);
    const architectureBinding = entries.get(architectureName);
    if (
      typeof aliasBinding !== "string" ||
      typeof canonicalBinding !== "string" ||
      typeof architectureBinding !== "string" ||
      aliasBinding !== canonicalBinding
    ) {
      throw new Error(
        "Canonical electron-winstaller 7-Zip aliases differ from the receipt-bound x64 baseline.",
      );
    }
    projectedAliases.set(aliasName, architectureBinding);
  }
  return `${lines
    .map((line) => {
      const name = line.slice(line.lastIndexOf(" ") + 1);
      const projectedBinding = projectedAliases.get(name);
      return projectedBinding === undefined
        ? line
        : `${projectedBinding} ${name}`;
    })
    .join("\n")}\n`;
}

async function expectedVendorInventory() {
  const { binding, contents } = await readPolicyFile(
    vendorInventoryPath,
    "electron-winstaller vendor receipt",
  );
  const lines = contents.endsWith("\n")
    ? contents.slice(0, -1).split("\n")
    : [];
  if (
    binding.sha256 !== EXPECTED_VENDOR_INVENTORY_SHA256 ||
    lines.length !== EXPECTED_VENDOR_FILE_COUNT ||
    lines.some(
      (line) =>
        !/^[a-f0-9]{64} [1-9][0-9]* [A-Za-z0-9][A-Za-z0-9._-]*$/u.test(line),
    ) ||
    JSON.stringify(lines) !==
      JSON.stringify(
        [...lines].sort((left, right) =>
          compareAscii(
            left.slice(left.lastIndexOf(" ") + 1),
            right.slice(right.lastIndexOf(" ") + 1),
          ),
        ),
      ) ||
    !lines.includes(
      `${STOCK_SQUIRREL_UPDATER.sha256} ${STOCK_SQUIRREL_UPDATER.bytes} Squirrel.exe`,
    )
  ) {
    throw new Error("electron-winstaller vendor receipt is malformed.");
  }
  return projectElectronWinstallerVendorInventoryForArchitecture(
    contents,
    process.arch,
  );
}

async function electronWinstallerVendorDirectory() {
  const manifestPath = require.resolve("electron-winstaller/package.json");
  const { contents } = await readPolicyFile(
    manifestPath,
    "electron-winstaller package manifest",
  );
  const manifest = JSON.parse(contents);
  if (
    manifest?.name !== "electron-winstaller" ||
    manifest?.version !== ELECTRON_WINSTALLER_VERSION
  ) {
    throw new Error(
      `electron-winstaller must remain exact at ${ELECTRON_WINSTALLER_VERSION}.`,
    );
  }
  return join(dirname(manifestPath), "vendor");
}

/** @param {unknown} releaseMode */
export function requireReviewedSquirrelReleaseMode(releaseMode) {
  if (releaseMode === "internal") return;
  if (releaseMode === "signed") {
    throw new Error(
      "Reviewed Squirrel updater remains internal-only pending redistribution review.",
    );
  }
  throw new Error("Squirrel updater release mode must be internal or signed.");
}

export async function verifyReviewedSquirrelUpdater() {
  const [binary, { contents }] = await Promise.all([
    hashPhysicalFile(
      reviewedBinaryPath,
      "reviewed Squirrel updater",
      MAX_VENDOR_FILE_BYTES,
    ),
    readPolicyFile(reviewPath, "reviewed Squirrel integration record"),
    verifyNormalizedBuildEvidence(),
  ]);
  const review = JSON.parse(contents);
  const confirmations = Array.isArray(review?.confirmations)
    ? review.confirmations
    : [];
  if (
    !hasExactKeys(review, [
      "binaryBytes",
      "binarySha256",
      "confirmations",
      "contractVersion",
      "dependencyInventorySha256",
      "integrationStatus",
      "mergeInputInventorySha256",
      "publicReleaseStatus",
      "sourceBaseCommit",
      "sourceFixCommit",
      "sourceFixTree",
      "sourceTestDependencyInventorySha256",
      "xdtAttributionSha256",
      "xdtLicenseSha256",
    ]) ||
    !confirmations.every(hasExactConfirmationKeys) ||
    binary.bytes !== REVIEWED_SQUIRREL_UPDATER.bytes ||
    binary.sha256 !== REVIEWED_SQUIRREL_UPDATER.sha256 ||
    review?.contractVersion !== 1 ||
    review?.integrationStatus !== REVIEWED_SQUIRREL_UPDATER.integrationStatus ||
    review?.publicReleaseStatus !==
      REVIEWED_SQUIRREL_UPDATER.publicReleaseStatus ||
    review?.binaryBytes !== REVIEWED_SQUIRREL_UPDATER.bytes ||
    review?.binarySha256 !== REVIEWED_SQUIRREL_UPDATER.sha256 ||
    review?.sourceBaseCommit !== REVIEWED_SQUIRREL_UPDATER.sourceBaseCommit ||
    review?.sourceFixCommit !== REVIEWED_SQUIRREL_UPDATER.sourceFixCommit ||
    review?.sourceFixTree !== REVIEWED_SQUIRREL_UPDATER.sourceFixTree ||
    review?.dependencyInventorySha256 !==
      REVIEWED_SQUIRREL_UPDATER.dependencyInventorySha256 ||
    review?.sourceTestDependencyInventorySha256 !==
      REVIEWED_SQUIRREL_UPDATER.sourceTestDependencyInventorySha256 ||
    review?.mergeInputInventorySha256 !==
      REVIEWED_SQUIRREL_UPDATER.mergeInputInventorySha256 ||
    review?.xdtLicenseSha256 !== REVIEWED_SQUIRREL_UPDATER.xdtLicenseSha256 ||
    review?.xdtAttributionSha256 !==
      REVIEWED_SQUIRREL_UPDATER.xdtAttributionSha256 ||
    confirmations.length !== 1 ||
    confirmations[0]?.workflowCommit !==
      "548a2c94a77de337a4980fefd8a27b2965db642c" ||
    confirmations[0]?.workflowRunId !== "29794447787" ||
    confirmations[0]?.artifactId !== "8481535392" ||
    confirmations[0]?.artifactArchiveSha256 !==
      "c01b2dcde1c527a1d2010ea5aa6d8d752a381c6c2f40fbe4a450af6f7ba22a31" ||
    confirmations[0]?.artifactProvenanceSha256 !==
      "153c1cf52c298f1da410b8cadfc16e309586214b2995f9ecfee22ce29acfeaf2"
  ) {
    throw new Error(
      "Reviewed Squirrel updater or integration record differs from policy.",
    );
  }
  return Object.freeze({ ...binary, path: reviewedBinaryPath });
}

export async function verifyElectronWinstallerVendor() {
  const directory = await electronWinstallerVendorDirectory();
  const expected = await expectedVendorInventory();
  const actual = await inventoryFlatVendorDirectory(
    directory,
    "electron-winstaller vendor",
  );
  if (actual !== expected) {
    throw new Error(
      "electron-winstaller vendor differs from the reviewed receipt.",
    );
  }
  return Object.freeze({
    directory,
    inventorySha256: EXPECTED_VENDOR_INVENTORY_SHA256,
  });
}

/** @param {string} stockInventory */
function reviewedOverlayInventory(stockInventory) {
  const stockLine = `${STOCK_SQUIRREL_UPDATER.sha256} ${STOCK_SQUIRREL_UPDATER.bytes} Squirrel.exe`;
  const reviewedLine = `${REVIEWED_SQUIRREL_UPDATER.sha256} ${REVIEWED_SQUIRREL_UPDATER.bytes} Squirrel.exe`;
  const reviewed = stockInventory.replace(stockLine, reviewedLine);
  if (reviewed === stockInventory) {
    throw new Error(
      "Reviewed Squirrel overlay receipt could not be projected.",
    );
  }
  return reviewed;
}

/** @param {string} directory */
export async function verifyReviewedSquirrelVendorOverlay(directory) {
  const expected = reviewedOverlayInventory(await expectedVendorInventory());
  const actual = await inventoryFlatVendorDirectory(
    directory,
    "reviewed Squirrel vendor overlay",
  );
  if (actual !== expected) {
    throw new Error("Reviewed Squirrel vendor overlay differs from policy.");
  }
  return Object.freeze({
    directory: resolve(directory),
    updaterSha256: REVIEWED_SQUIRREL_UPDATER.sha256,
  });
}

/**
 * Squirrel writes this fixed-name diagnostic beside its executable during
 * `--releasify`. It can contain host paths, so never read, retain, or upload
 * it. Accept only this one bounded physical residue, unlink it, then require
 * both the disposable overlay and the original package vendor to remain exact.
 *
 * @param {string} directory
 */
export async function finalizeReviewedSquirrelVendorOverlay(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const residue = entries.find(
    (entry) => entry.name === SQUIRREL_RELEASIFY_LOG,
  );
  if (residue !== undefined) {
    if (
      entries.length !== EXPECTED_VENDOR_FILE_COUNT + 1 ||
      !residue.isFile() ||
      residue.isSymbolicLink()
    ) {
      throw new Error(
        "Reviewed Squirrel vendor overlay has unexpected maker residue.",
      );
    }
    const residuePath = join(directory, SQUIRREL_RELEASIFY_LOG);
    const metadata = await lstat(residuePath, { bigint: true });
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > BigInt(MAX_SQUIRREL_RELEASIFY_LOG_BYTES)
    ) {
      throw new Error("Squirrel releasify log is not a bounded physical file.");
    }
    await unlink(residuePath);
  }
  const [overlay] = await Promise.all([
    verifyReviewedSquirrelVendorOverlay(directory),
    verifyElectronWinstallerVendor(),
  ]);
  return overlay;
}

/**
 * @param {string} directory
 * @param {unknown} releaseMode
 */
export async function prepareReviewedSquirrelVendorOverlay(
  directory,
  releaseMode,
) {
  requireReviewedSquirrelReleaseMode(releaseMode);
  const [{ directory: sourceDirectory }, reviewedUpdater] = await Promise.all([
    verifyElectronWinstallerVendor(),
    verifyReviewedSquirrelUpdater(),
  ]);
  try {
    await lstat(directory);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
    await cp(sourceDirectory, directory, {
      errorOnExist: true,
      force: false,
      recursive: true,
    });
    const copiedInventory = await inventoryFlatVendorDirectory(
      directory,
      "copied electron-winstaller vendor",
    );
    if (copiedInventory !== (await expectedVendorInventory())) {
      throw new Error(
        "Temporary electron-winstaller vendor copy is not exact.",
      );
    }
    await copyFile(reviewedUpdater.path, join(directory, "Squirrel.exe"));
    const overlay = await verifyReviewedSquirrelVendorOverlay(directory);
    if (
      (await inventoryFlatVendorDirectory(
        sourceDirectory,
        "electron-winstaller vendor after overlay creation",
      )) !== (await expectedVendorInventory())
    ) {
      throw new Error("Creating the temporary overlay changed node_modules.");
    }
    return overlay;
  }
  throw new Error("Temporary Squirrel vendor overlay path already exists.");
}
