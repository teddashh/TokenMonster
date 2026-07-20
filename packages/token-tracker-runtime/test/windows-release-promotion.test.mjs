import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fullSquirrelPackageNameForVersion } from "../../../scripts/release/windows-squirrel-promotion-policy.mjs";

const rootDirectory = resolve(import.meta.dirname, "..", "..", "..");
const prepareScript = join(
  rootDirectory,
  "scripts",
  "release",
  "prepare-windows-promotion.mjs",
);
const verifyScript = join(
  rootDirectory,
  "scripts",
  "release",
  "verify-windows-promotion.mjs",
);
const verifySquirrelScript = join(
  rootDirectory,
  "scripts",
  "release",
  "verify-windows-squirrel-candidate.mjs",
);
const planSquirrelScript = join(
  rootDirectory,
  "scripts",
  "release",
  "plan-windows-squirrel-promotion.mjs",
);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function sha1(contents) {
  return createHash("sha1").update(contents).digest("hex");
}

async function fixture(version = "0.1.0", marker = 0x31) {
  const directory = await mkdtemp(join(tmpdir(), "windows-promotion-"));
  temporaryDirectories.push(directory);
  const artifacts = join(directory, "artifacts");
  const channel = join(directory, "channel");
  const prepared = join(directory, "prepared");
  const recalled = join(directory, "recalled.exe");
  const fullPackageFileName = fullSquirrelPackageNameForVersion(version);
  const fullPackage = Buffer.alloc(8_192, marker);
  await Promise.all([mkdir(artifacts), mkdir(channel)]);
  await Promise.all([
    writeFile(
      join(artifacts, "TokenMonsterSetup.exe"),
      Buffer.alloc(1_048_576, 0x5a),
    ),
    writeFile(join(artifacts, fullPackageFileName), fullPackage),
    writeFile(
      join(artifacts, "RELEASES"),
      `${sha1(fullPackage)} ${fullPackageFileName} ${fullPackage.byteLength}\n`,
    ),
  ]);
  await Promise.all([
    cp(join(artifacts, "RELEASES"), join(channel, "RELEASES")),
    cp(
      join(artifacts, fullPackageFileName),
      join(channel, fullPackageFileName),
    ),
  ]);
  return {
    artifacts,
    channel,
    directory,
    fullPackage,
    fullPackageFileName,
    prepared,
    recalled,
    version,
  };
}

function run(script, arguments_) {
  return spawnSync(process.execPath, [script, ...arguments_], {
    cwd: rootDirectory,
    encoding: "utf8",
  });
}

function prepare(paths) {
  return run(prepareScript, [
    "--artifact-dir",
    paths.artifacts,
    "--output-dir",
    paths.prepared,
    "--version",
    paths.version,
  ]);
}

function candidatePath(paths) {
  return join(paths.prepared, "windows-squirrel-candidate-v1.json");
}

describe("Windows release promotion evidence", () => {
  it("binds the exact signed-job inventory to the CTA and stable Squirrel feed", async () => {
    const paths = await fixture();
    const prepared = prepare(paths);
    expect(prepared.status, prepared.stderr).toBe(0);
    await cp(join(paths.prepared, "TokenMonsterSetup.exe"), paths.recalled);

    const squirrelVerification = run(verifySquirrelScript, [
      "--prepared-dir",
      paths.prepared,
      "--version",
      paths.version,
    ]);
    expect(squirrelVerification.status, squirrelVerification.stderr).toBe(0);
    expect(JSON.parse(squirrelVerification.stdout)).toMatchObject({
      verification: "local-files-and-releases-entry-match",
      version: "0.1.0",
      channel: "latest",
      feedUrl:
        "https://cdn.ted-h.com/tokenmonster/releases/windows/squirrel/latest/",
    });

    const verify = run(verifyScript, [
      "--prepared-dir",
      paths.prepared,
      "--recalled-file",
      paths.recalled,
      "--version",
      paths.version,
    ]);
    expect(verify.status, verify.stderr).toBe(0);
    const release = JSON.parse(
      await readFile(join(paths.prepared, "public-release-v1.json"), "utf8"),
    );
    expect(release).toMatchObject({
      contractVersion: 1,
      version: "0.1.0",
      bytes: 1_048_576,
      downloadUrl:
        "https://cdn.ted-h.com/tokenmonster/releases/windows/v0.1.0/TokenMonsterSetup.exe",
    });
    const manifest = JSON.parse(
      await readFile(
        join(paths.prepared, "promotion-manifest-v1.json"),
        "utf8",
      ),
    );
    expect(manifest).toMatchObject({
      promotionContractVersion: 1,
      cdnObject: {
        key: "tokenmonster/releases/windows/v0.1.0/TokenMonsterSetup.exe",
      },
      workerBinding: { name: "TOKENMONSTER_PUBLIC_RELEASE_JSON" },
    });
    expect(manifest.sourceArtifact.sha256).toBe(release.sha256);

    const candidate = JSON.parse(
      await readFile(candidatePath(paths), "utf8"),
    );
    expect(candidate).toMatchObject({
      squirrelCandidateContractVersion: 1,
      version: "0.1.0",
      channel: "latest",
      releaseEntry: {
        fileName: "TokenMonster-0.1.0-full.nupkg",
        bytes: paths.fullPackage.byteLength,
      },
      objects: [
        {
          role: "releases",
          immutableKey:
            "tokenmonster/releases/windows/squirrel/v0.1.0/RELEASES",
          channelKey:
            "tokenmonster/releases/windows/squirrel/latest/RELEASES",
        },
        {
          role: "full-package",
          immutableKey:
            "tokenmonster/releases/windows/squirrel/v0.1.0/TokenMonster-0.1.0-full.nupkg",
          channelKey:
            "tokenmonster/releases/windows/squirrel/latest/TokenMonster-0.1.0-full.nupkg",
        },
      ],
    });

    const plan = run(planSquirrelScript, [
      "--missing",
      "--candidate",
      candidatePath(paths),
      "--candidate-dir",
      paths.prepared,
    ]);
    expect(plan.status, plan.stderr).toBe(0);
    expect(JSON.parse(plan.stdout)).toMatchObject({
      squirrelPromotionPlanContractVersion: 1,
      decision: "advance",
      channel: "latest",
      currentVersion: null,
      candidateVersion: "0.1.0",
      immutableObjects: [
        {
          sequence: 1,
          role: "full-package",
          operation: "create-or-verify-exact",
        },
        {
          sequence: 2,
          role: "releases",
          operation: "create-or-verify-exact",
        },
      ],
      channelTransition: {
        writesInOrder: [
          { sequence: 1, role: "full-package" },
          { sequence: 2, role: "releases" },
        ],
        retainedForClientOverlap: [],
      },
    });

    const rerunArguments = [
      "--current",
      candidatePath(paths),
      "--current-dir",
      paths.channel,
      "--candidate",
      candidatePath(paths),
      "--candidate-dir",
      paths.prepared,
    ];
    const rerun = run(planSquirrelScript, rerunArguments);
    const repeatedRerun = run(planSquirrelScript, rerunArguments);
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(repeatedRerun.status, repeatedRerun.stderr).toBe(0);
    expect(repeatedRerun.stdout).toBe(rerun.stdout);
    expect(JSON.parse(rerun.stdout)).toMatchObject({
      decision: "idempotent",
      currentVersion: "0.1.0",
      candidateVersion: "0.1.0",
      channelTransition: {
        writesInOrder: [],
        retainedForClientOverlap: [],
      },
    });

    const evidence = JSON.parse(
      await readFile(
        join(paths.prepared, "promotion-evidence-v1.json"),
        "utf8",
      ),
    );
    expect(evidence.verification).toBe(
      "full-get-sha256-and-bytes-match",
    );
    expect(evidence.sourceArtifact.sha256).toBe(evidence.fullCdnGet.sha256);
    expect(evidence.sourceArtifact.bytes).toBe(evidence.fullCdnGet.bytes);
  });

  it("derives next from the shared SemVer contract and plans package-before-metadata", async () => {
    const current = await fixture("0.1.0-rc.11", 0x41);
    const candidate = await fixture("0.1.0-rc.12", 0x42);
    expect(prepare(current).status).toBe(0);
    expect(prepare(candidate).status).toBe(0);

    const candidateState = JSON.parse(
      await readFile(candidatePath(candidate), "utf8"),
    );
    expect(candidateState).toMatchObject({
      version: "0.1.0-rc.12",
      channel: "next",
      feedUrl:
        "https://cdn.ted-h.com/tokenmonster/releases/windows/squirrel/next/",
      releaseEntry: {
        fileName: "TokenMonster-0.1.0-rc12-full.nupkg",
      },
    });

    const plan = run(planSquirrelScript, [
      "--current",
      candidatePath(current),
      "--current-dir",
      current.channel,
      "--candidate",
      candidatePath(candidate),
      "--candidate-dir",
      candidate.prepared,
    ]);
    expect(plan.status, plan.stderr).toBe(0);
    expect(JSON.parse(plan.stdout)).toMatchObject({
      decision: "advance",
      channel: "next",
      currentVersion: "0.1.0-rc.11",
      candidateVersion: "0.1.0-rc.12",
      channelTransition: {
        writesInOrder: [
          {
            sequence: 1,
            role: "full-package",
            destinationKey:
              "tokenmonster/releases/windows/squirrel/next/TokenMonster-0.1.0-rc12-full.nupkg",
          },
          {
            sequence: 2,
            role: "releases",
            destinationKey:
              "tokenmonster/releases/windows/squirrel/next/RELEASES",
          },
        ],
        retainedForClientOverlap: [
          {
            destinationKey:
              "tokenmonster/releases/windows/squirrel/next/TokenMonster-0.1.0-rc11-full.nupkg",
            operation: "retain-until-separate-retention-aware-gc",
          },
        ],
      },
    });
  });

  it("rejects same-version byte drift, downgrade, and cross-channel state", async () => {
    const original = await fixture("0.1.0-rc.12", 0x51);
    const drifted = await fixture("0.1.0-rc.12", 0x52);
    const older = await fixture("0.1.0-rc.11", 0x53);
    const stable = await fixture("0.1.0", 0x54);
    for (const paths of [original, drifted, older, stable]) {
      const result = prepare(paths);
      expect(result.status, result.stderr).toBe(0);
    }

    const drift = run(planSquirrelScript, [
      "--current",
      candidatePath(original),
      "--current-dir",
      original.channel,
      "--candidate",
      candidatePath(drifted),
      "--candidate-dir",
      drifted.prepared,
    ]);
    expect(drift.status).not.toBe(0);
    expect(drift.stderr).toContain("different bytes");

    const downgrade = run(planSquirrelScript, [
      "--current",
      candidatePath(original),
      "--current-dir",
      original.channel,
      "--candidate",
      candidatePath(older),
      "--candidate-dir",
      older.prepared,
    ]);
    expect(downgrade.status).not.toBe(0);
    expect(downgrade.stderr).toContain("downgrade");

    const channelDrift = run(planSquirrelScript, [
      "--current",
      candidatePath(stable),
      "--current-dir",
      stable.channel,
      "--candidate",
      candidatePath(original),
      "--candidate-dir",
      original.prepared,
    ]);
    expect(channelDrift.status).not.toBe(0);
    expect(channelDrift.stderr).toContain("channel drift");

    const staleDelta = join(
      original.channel,
      "TokenMonster-0.1.0-rc12-delta.nupkg",
    );
    await writeFile(staleDelta, "stale delta");
    const extraCurrentObject = run(planSquirrelScript, [
      "--current",
      candidatePath(original),
      "--current-dir",
      original.channel,
      "--candidate",
      candidatePath(original),
      "--candidate-dir",
      original.prepared,
    ]);
    expect(extraCurrentObject.status).not.toBe(0);
    expect(extraCurrentObject.stderr).toContain("exactly RELEASES");
    await rm(staleDelta);

    await writeFile(
      join(original.channel, original.fullPackageFileName),
      Buffer.alloc(original.fullPackage.byteLength, 0x7f),
    );
    const remoteByteDrift = run(planSquirrelScript, [
      "--current",
      candidatePath(original),
      "--current-dir",
      original.channel,
      "--candidate",
      candidatePath(original),
      "--candidate-dir",
      original.prepared,
    ]);
    expect(remoteByteDrift.status).not.toBe(0);
    expect(remoteByteDrift.stderr).toMatch(/hash|RELEASES/u);
  });

  it("rejects extra, missing, nested, delta, and version-drifted inventory", async () => {
    const extra = await fixture("0.1.0-rc.11");
    await writeFile(join(extra.artifacts, "debug.pdb"), "debug");

    const missing = await fixture("0.1.0-rc.11");
    await rm(join(missing.artifacts, "RELEASES"));

    const nested = await fixture("0.1.0-rc.11");
    await mkdir(join(nested.artifacts, "nested"));

    const delta = await fixture("0.1.0-rc.11");
    await writeFile(
      join(delta.artifacts, "TokenMonster-0.1.0-rc11-delta.nupkg"),
      "delta",
    );

    const versionDrift = await fixture("0.1.0-rc.11");
    await rename(
      join(versionDrift.artifacts, versionDrift.fullPackageFileName),
      join(versionDrift.artifacts, "TokenMonster-0.1.0-rc12-full.nupkg"),
    );

    for (const paths of [extra, missing, nested, delta, versionDrift]) {
      const result = prepare(paths);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("exactly RELEASES");
    }
  });

  it("rejects RELEASES hash, size, path, extra-entry, and UTF-8 drift", async () => {
    const hashMismatch = await fixture("0.1.0-rc.11");
    await writeFile(
      join(hashMismatch.artifacts, "RELEASES"),
      `${"0".repeat(40)} ${hashMismatch.fullPackageFileName} ${hashMismatch.fullPackage.byteLength}\n`,
    );

    const sizeMismatch = await fixture("0.1.0-rc.11");
    await writeFile(
      join(sizeMismatch.artifacts, "RELEASES"),
      `${sha1(sizeMismatch.fullPackage)} ${sizeMismatch.fullPackageFileName} ${sizeMismatch.fullPackage.byteLength + 1}\n`,
    );

    const pathEscape = await fixture("0.1.0-rc.11");
    await writeFile(
      join(pathEscape.artifacts, "RELEASES"),
      `${sha1(pathEscape.fullPackage)} ../${pathEscape.fullPackageFileName} ${pathEscape.fullPackage.byteLength}\n`,
    );

    const extraEntry = await fixture("0.1.0-rc.11");
    await writeFile(
      join(extraEntry.artifacts, "RELEASES"),
      `${sha1(extraEntry.fullPackage)} ${extraEntry.fullPackageFileName} ${extraEntry.fullPackage.byteLength}\n${"0".repeat(40)} TokenMonster-0.1.0-rc11-delta.nupkg 1\n`,
    );

    const invalidUtf8 = await fixture("0.1.0-rc.11");
    await writeFile(
      join(invalidUtf8.artifacts, "RELEASES"),
      Buffer.from([0xc3, 0x28]),
    );

    for (const paths of [
      hashMismatch,
      sizeMismatch,
      pathEscape,
      extraEntry,
      invalidUtf8,
    ]) {
      const result = prepare(paths);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/RELEASES/u);
    }
  });

  it("rejects prepared-byte and canonical candidate drift before promotion", async () => {
    const packageDrift = await fixture("0.1.0-rc.11");
    expect(prepare(packageDrift).status).toBe(0);
    await writeFile(
      join(packageDrift.prepared, packageDrift.fullPackageFileName),
      Buffer.alloc(packageDrift.fullPackage.byteLength, 0x72),
    );
    const packageVerification = run(verifySquirrelScript, [
      "--prepared-dir",
      packageDrift.prepared,
      "--version",
      packageDrift.version,
    ]);
    expect(packageVerification.status).not.toBe(0);
    expect(packageVerification.stderr).toMatch(/hash|RELEASES/u);

    const candidateDrift = await fixture("0.1.0-rc.11");
    expect(prepare(candidateDrift).status).toBe(0);
    const path = candidatePath(candidateDrift);
    const candidate = JSON.parse(await readFile(path, "utf8"));
    candidate.channel = "latest";
    await writeFile(path, `${JSON.stringify(candidate, null, 2)}\n`);
    const candidateVerification = run(verifySquirrelScript, [
      "--prepared-dir",
      candidateDrift.prepared,
      "--version",
      candidateDrift.version,
    ]);
    expect(candidateVerification.status).not.toBe(0);
    expect(candidateVerification.stderr).toMatch(/channel|drift/u);
  });

  it("still rejects a substituted CTA response", async () => {
    const paths = await fixture("0.1.0-rc.11");
    const prepared = prepare(paths);
    expect(prepared.status, prepared.stderr).toBe(0);
    await writeFile(paths.recalled, Buffer.alloc(1_048_576, 0x6b));
    const verify = run(verifyScript, [
      "--prepared-dir",
      paths.prepared,
      "--recalled-file",
      paths.recalled,
      "--version",
      paths.version,
    ]);
    expect(verify.status).not.toBe(0);
    expect(verify.stderr).toContain("does not match");
  });
});
