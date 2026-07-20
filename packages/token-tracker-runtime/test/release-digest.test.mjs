import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyReleaseDigest } from "../../../scripts/release/verify-release-digest.mjs";
import {
  portablePublicTarEntryKey,
  PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRY,
  requirePublicAssetAuthority,
  requirePublicTarEntry,
} from "../../../scripts/release/public-artifact-policy.mjs";
import { ZSTD_NATIVE_POLICY } from "../src/zstd-native-verifier.ts";

const ZSTD_POLICY_ENTRY =
  "node_modules/@tokenmonster/token-tracker-runtime/dist/zstd-native-policy.json";
const ZSTD_VERIFIER_ENTRY =
  "node_modules/@tokenmonster/token-tracker-runtime/dist/zstd-native-verifier.js";
const BUILT_ZSTD_VERIFIER = resolve(
  import.meta.dirname,
  "..",
  "dist",
  "zstd-native-verifier.js",
);

const directories = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixture(entryName = "index.js", options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tokenmonster-digest-"));
  directories.push(directory);
  const version = options.version ?? "0.1.0-rc.11";
  const tarballName = `tokenmonster-${version}.tgz`;
  const packageDirectory = join(directory, "package");
  await mkdir(packageDirectory);
  await writeFile(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({ name: "tokenmonster", version })}\n`,
  );
  const entryPath = join(packageDirectory, entryName);
  await mkdir(dirname(entryPath), { recursive: true });
  await writeFile(entryPath, "fixture text\n");
  for (const additionalEntry of options.additionalEntries ?? []) {
    const additionalPath = join(packageDirectory, additionalEntry);
    await mkdir(dirname(additionalPath), { recursive: true });
    await writeFile(additionalPath, "additional fixture text\n");
  }
  if (options.includeZstdPolicy !== false) {
    const policyPath = join(packageDirectory, ZSTD_POLICY_ENTRY);
    await mkdir(dirname(policyPath), { recursive: true });
    await writeFile(
      policyPath,
      `${JSON.stringify(options.zstdPolicy ?? ZSTD_NATIVE_POLICY, null, 2)}\n`,
    );
  }
  if (options.includeZstdVerifier !== false) {
    const verifierPath = join(packageDirectory, ZSTD_VERIFIER_ENTRY);
    await mkdir(dirname(verifierPath), { recursive: true });
    await writeFile(
      verifierPath,
      options.zstdVerifier ?? (await readFile(BUILT_ZSTD_VERIFIER)),
    );
  }
  const archive = spawnSync(
    "tar",
    ["-czf", join(directory, tarballName), "-C", directory, "package"],
    { encoding: "utf8" },
  );
  if (archive.status !== 0) {
    throw new Error(`test tar creation failed: ${archive.stderr}`);
  }
  const bytes = await readFile(join(directory, tarballName));
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(
    join(directory, "SHASUMS256.txt"),
    `${digest}  ${tarballName}\n`,
  );
  return { directory, tarballName, bytes: bytes.length, digest };
}

describe("cross-platform release digest verifier", () => {
  it("accepts one exact canonical tarball record", async () => {
    const { directory, tarballName, bytes, digest } = await fixture();
    await expect(verifyReleaseDigest(directory)).resolves.toMatchObject({
      tarballName,
      bytes,
      sha256: digest,
      entryCount: 9,
      version: "0.1.0-rc.11",
    });
    await expect(
      verifyReleaseDigest(directory, { expectedVersion: "0.1.0-rc.11" }),
    ).resolves.toBeDefined();
    await expect(
      verifyReleaseDigest(directory, { expectedVersion: "0.1.0-rc.12" }),
    ).rejects.toThrow(/expected release version/u);
  });

  it("rejects changed bytes and ambiguous tarball inventories", async () => {
    const changed = await fixture();
    await writeFile(join(changed.directory, changed.tarballName), "changed");
    await expect(verifyReleaseDigest(changed.directory)).rejects.toThrow(
      /SHA-256 differs/u,
    );

    const ambiguous = await fixture();
    await writeFile(join(ambiguous.directory, "tokenmonster-extra.tgz"), "x");
    await expect(verifyReleaseDigest(ambiguous.directory)).rejects.toThrow(
      /exactly the checksummed tarball/u,
    );
  });

  it("rejects binary asset extensions case-insensitively", async () => {
    const denied = await fixture("avatar.PNG");
    await expect(verifyReleaseDigest(denied.directory)).rejects.toThrow(
      /forbidden binary asset/u,
    );
  });

  it("accepts the portable shapes used by the current public inventory", () => {
    const inventory = [
      "package/",
      "package/README.md",
      "package/npm-shrinkwrap.json",
      "package/node_modules/@tokenmonster/token-tracker-runtime/dist/network-deny.d.cts",
      "package/node_modules/zod/src/v4/core/json-schema-processors.ts",
    ];
    for (const entry of inventory) {
      expect(requirePublicTarEntry(entry)).toBe(entry);
    }
    expect(portablePublicTarEntryKey("package/README.md")).toBe(
      "package/readme.md",
    );
  });

  it("rejects ASCII case collisions and non-portable Windows names", async () => {
    const caseCollision = await fixture("index.js", {
      additionalEntries: ["Index.js"],
    });
    await expect(verifyReleaseDigest(caseCollision.directory)).rejects.toThrow(
      /portable path collision/u,
    );

    const reserved = await fixture("CON");
    await expect(verifyReleaseDigest(reserved.directory)).rejects.toThrow(
      /portable names/u,
    );
  });

  it("rejects Unicode instead of approximating portable case folding", async () => {
    const nonPortableEntries = [
      "package/\u03a3.js",
      "package/\u03c2.js",
      "package/COM\u00b9.txt",
      "package/caf\u00e9.js",
      "package/cafe\u0301.js",
    ];
    for (const entry of nonPortableEntries) {
      expect(() => requirePublicTarEntry(entry)).toThrow(/portable names/u);
      expect(() => portablePublicTarEntryKey(entry)).toThrow(/portable names/u);
    }

    const sigmaCaseFold = await fixture("\u03a3.js", {
      additionalEntries: ["\u03c2.js"],
    });
    await expect(verifyReleaseDigest(sigmaCaseFold.directory)).rejects.toThrow(
      /portable names/u,
    );

    const normalization = await fixture("caf\u00e9.js", {
      additionalEntries: ["cafe\u0301.js"],
    });
    await expect(verifyReleaseDigest(normalization.directory)).rejects.toThrow(
      /portable names/u,
    );

    const superscriptDeviceName = await fixture("COM\u00b9.txt");
    await expect(
      verifyReleaseDigest(superscriptDeviceName.directory),
    ).rejects.toThrow(/portable names/u);
  });

  it("rejects trailing dots, spaces, illegal characters, and long components", () => {
    const nonPortableEntries = [
      "package/trailing.",
      "package/trailing ",
      "package/has space.js",
      "package/has:colon.js",
      "package/.hidden",
      `package/${"a".repeat(256)}.js`,
    ];
    for (const entry of nonPortableEntries) {
      expect(() => requirePublicTarEntry(entry)).toThrow(/portable names/u);
    }
  });

  it("requires the exact shipped zstd policy and verifier inventory", async () => {
    const missingPolicy = await fixture("index.js", {
      includeZstdPolicy: false,
    });
    await expect(verifyReleaseDigest(missingPolicy.directory)).rejects.toThrow(
      /omits the shipped zstd native policy/u,
    );

    const missingVerifier = await fixture("index.js", {
      includeZstdVerifier: false,
    });
    await expect(
      verifyReleaseDigest(missingVerifier.directory),
    ).rejects.toThrow(/omits the shipped zstd native verifier/u);

    const changedPolicy = JSON.parse(JSON.stringify(ZSTD_NATIVE_POLICY));
    changedPolicy.platforms["linux-x64"].archiveSha256 = "0".repeat(64);
    const drifted = await fixture("index.js", {
      zstdPolicy: changedPolicy,
    });
    await expect(verifyReleaseDigest(drifted.directory)).rejects.toThrow(
      /differs from the release authority/u,
    );

    const verifierBytes = await readFile(BUILT_ZSTD_VERIFIER);
    verifierBytes[0] ^= 0xff;
    const changedVerifier = await fixture("index.js", {
      zstdVerifier: verifierBytes,
    });
    await expect(
      verifyReleaseDigest(changedVerifier.directory),
    ).rejects.toThrow(/verifier differs from its pinned bytes/u);
  });

  it("allows only the one fixed character authority JSON path", async () => {
    const exact = await fixture(
      "node_modules/@tokenmonster/characters/dist/approved-release-v2.json",
    );
    await expect(verifyReleaseDigest(exact.directory)).resolves.toBeDefined();

    const legacy = await fixture(
      "node_modules/@tokenmonster/characters/dist/approved-manifest.json",
    );
    await expect(verifyReleaseDigest(legacy.directory)).rejects.toThrow(
      /non-authority character JSON/u,
    );
  });

  it("rejects malformed and legacy authority content before staging", () => {
    const strictV2 = (authority) => {
      if (authority.releaseId !== "valid-release") {
        throw new Error("strict v2 validation failed");
      }
      return authority;
    };
    expect(
      requirePublicAssetAuthority(
        PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRY,
        Buffer.from("null\n"),
        strictV2,
      ),
    ).toBeNull();
    expect(() =>
      requirePublicAssetAuthority(
        PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRY,
        Buffer.from('{"schemaVersion":"1"}\n'),
        strictV2,
      ),
    ).toThrow(/null or schema-v2/u);
    expect(() =>
      requirePublicAssetAuthority(
        PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRY,
        Buffer.from('{"schemaVersion":"2"}\n'),
        strictV2,
      ),
    ).toThrow(/strict v2 validation failed/u);
  });
});
