import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifiedPackagedTokscaleBinary } from "../src/main/packaged-collector.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

function targetKey(): string | null {
  if (
    process.platform === "darwin" &&
    (process.arch === "x64" || process.arch === "arm64")
  ) {
    return `${process.platform}-${process.arch}`;
  }
  if (
    process.platform === "linux" &&
    (process.arch === "x64" || process.arch === "arm64")
  ) {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: unknown } }
      | undefined;
    const libc =
      typeof report?.header?.glibcVersionRuntime === "string" ? "gnu" : "musl";
    return `${process.platform}-${process.arch}-${libc}`;
  }
  return null;
}

function packageName(key: string): string {
  return `@tokscale/cli-${key}`;
}

function digest(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function fixture(): Promise<Readonly<{
  appPath: string;
  resourcesPath: string;
  binaryPath: string;
}>> {
  const key = targetKey();
  if (key === null) throw new Error("unsupported test platform");
  const root = await mkdtemp(join(tmpdir(), "tokenmonster-packaged-collector-"));
  directories.push(root);
  const appPath = join(root, "app.asar");
  const resourcesPath = join(root, "resources");
  const targetDirectory = join(resourcesPath, "collector", "tokscale");
  await mkdir(join(appPath, "packaging"), { recursive: true });
  await mkdir(targetDirectory, { recursive: true });

  const expectedFiles = [
    {
      source: "bin/tokscale",
      target: "tokscale",
      contents: Buffer.from("audited-test-tokscale"),
      mode: "0755" as const,
      executable: true,
    },
    ...(key === "darwin-arm64"
      ? [
          {
            source: "bin/libFoundationModels.dylib",
            target: "libFoundationModels.dylib",
            contents: Buffer.from("audited-test-foundation-models"),
            mode: "0644" as const,
            executable: false,
          },
        ]
      : []),
  ];
  for (const file of expectedFiles) {
    const path = join(targetDirectory, file.target);
    await writeFile(path, file.contents);
    await chmod(path, Number.parseInt(file.mode, 8));
  }
  const manifest = {
    schemaVersion: 1,
    collector: {
      status: "ready",
      name: "tokscale",
      sourceVersion: "4.5.2",
      versionOutput: "tokscale 4.5.2",
      extraResourceTarget: "collector/tokscale",
      runtimeBase: "process.resourcesPath",
      targets: {
        [key]: {
          runtimeEnabled: true,
          package: packageName(key),
          packageVersion: "4.5.2",
          lockIntegrity: `sha512-${"A".repeat(86)}==`,
          files: expectedFiles.map(({ contents, ...file }) => ({
            ...file,
            sha256: digest(contents),
          })),
        },
      },
    },
  };
  await writeFile(
    join(appPath, "packaging", "runtime-bundle-manifest.json"),
    JSON.stringify(manifest),
  );
  return Object.freeze({
    appPath,
    resourcesPath,
    binaryPath: join(targetDirectory, "tokscale"),
  });
}

describe.skipIf(targetKey() === null)("packaged collector verification", () => {
  it("returns only the fixed binary after manifest, inventory, mode, and hash checks", async () => {
    const input = await fixture();
    await expect(verifiedPackagedTokscaleBinary(input)).resolves.toBe(
      input.binaryPath,
    );
  });

  it("fails closed for modified or additional resources", async () => {
    const modified = await fixture();
    await writeFile(modified.binaryPath, "modified");
    await expect(verifiedPackagedTokscaleBinary(modified)).resolves.toBeNull();

    const additional = await fixture();
    await writeFile(
      join(additional.resourcesPath, "collector", "tokscale", "unexpected"),
      "extra",
    );
    await expect(verifiedPackagedTokscaleBinary(additional)).resolves.toBeNull();
  });

  it("fails closed when packaged release policy is no longer ready", async () => {
    const input = await fixture();
    const manifestPath = join(
      input.appPath,
      "packaging",
      "runtime-bundle-manifest.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      collector: { status: string };
    };
    manifest.collector.status = "blocked";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifiedPackagedTokscaleBinary(input)).resolves.toBeNull();
  });
});
