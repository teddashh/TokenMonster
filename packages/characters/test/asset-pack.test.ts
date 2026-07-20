import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";
import { ZipFile as YazlZipFile } from "yazl";

import {
  ASSET_PACK_ALLOWLIST_SCHEMA_VERSION,
  ASSET_PACK_DESCRIPTOR_SCHEMA_VERSION,
  AssetPackError,
  MAX_ASSET_PACK_ENTRIES,
  MAX_ASSET_PACK_EXTRACTED_BYTES,
  MAX_ASSET_PACK_TRANSFER_BYTES,
  installFixedAssetPack,
  planFixedAssetPack,
  recoverFixedAssetPackCache,
  type AssetPackFetch,
  type AssetPackFetchRequestInit,
  type AssetPackFetchResponse,
  type AssetPackResponseBody,
  type AssetPackStreamReader,
} from "../src/asset-pack.js";
import {
  AssetReleaseManifestV2Schema,
  computeAssetReleaseManifestV2Sha256,
  type AssetReleaseManifestV2,
} from "../src/asset-release.js";
import * as charactersMain from "../src/index.js";

const PRIVATE_ORIGIN = "https://assets.example.test";
const FIXED_MTIME = new Date("2026-01-01T00:00:00.000Z");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function pngBytes(label: string): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from(`tokenmonster:${label}`)]);
}

type PackObject = Readonly<{
  bytes: Buffer;
  path: string;
  sha256: string;
}>;

function packObject(label: string): PackObject {
  const bytes = pngBytes(label);
  const hash = sha256(bytes);
  return Object.freeze({
    bytes,
    path: `objects/${hash}.png`,
    sha256: hash,
  });
}

function releaseEntry(
  object: PackObject,
  association:
    | Readonly<{ kind: "avatar"; characterId: "chatgpt" }>
    | Readonly<{
        kind: "outfit";
        characterId: "chatgpt";
        themeId: "tech";
      }>,
) {
  const assetId =
    association.kind === "avatar"
      ? "asset:chatgpt:avatar"
      : "asset:chatgpt:theme:tech:outfit";
  return {
    assetId,
    association,
    source: {
      inventoryId: "fixed-pack-test-inventory",
      inventoryRevision: "8".repeat(64),
      path: `fixtures/${association.kind}.png`,
      sha256: association.kind === "avatar" ? "1".repeat(64) : "2".repeat(64),
    },
    output: {
      path: object.path,
      bytes: object.bytes.length,
      sha256: object.sha256,
      media: { mediaType: "image/png" as const, width: 32, height: 32 },
    },
    generationHistory: {
      tool: { name: "fixture-renderer", version: "1.0.0" },
      sourceMediaType: "image/png" as const,
      resize: { width: 32, height: 32, algorithm: "nearest" as const },
      encoding: { mediaType: "image/png" as const, quality: null },
      metadataStripped: true as const,
    },
    rights: {
      licenseStatus: "approved" as const,
      grantReferenceId: "grant-fixed-pack-test",
      scopes: {
        publicUse: true as const,
        commercialUse: true as const,
        modify: true as const,
        redistribute: true as const,
      },
    },
    review: {
      brandStatus: "approved" as const,
      brandReviewReferenceId: "brand-fixed-pack-test",
      contentStatus: "approved" as const,
      contentReviewReferenceId: "content-fixed-pack-test",
      contentRating: "general" as const,
      disclosureId: "disclosure-fixed-pack-test",
    },
    presentation: {
      altText: {
        "zh-TW": "固定包測試角色圖",
        en: "Fixed pack test character art",
      },
      allowedTransforms: ["scale-down" as const],
    },
    releaseStatus: "approved" as const,
  };
}

function releaseManifest(
  objects: ReadonlyArray<PackObject>,
): AssetReleaseManifestV2 {
  const associations = [
    { kind: "avatar", characterId: "chatgpt" },
    { kind: "outfit", characterId: "chatgpt", themeId: "tech" },
  ] as const;
  return AssetReleaseManifestV2Schema.parse({
    schemaVersion: "2",
    releaseId: "characters-2026.07.17",
    approvedAt: "2026-07-17T12:00:00.000Z",
    provenance: {
      integrityManifestSha256: "a".repeat(64),
      buildProvenanceSha256: "b".repeat(64),
      pipeline: {
        repositoryId: "tokenmonster",
        revision: "c".repeat(40),
        scriptPath: "scripts/asset-pipeline/build-manifest.mjs",
      },
    },
    assets: objects.map((object, index) =>
      releaseEntry(object, associations[index]!),
    ),
  });
}

type ZipEntryFixture = Readonly<{
  path: string;
  bytes: Buffer;
  mode?: number;
}>;

async function createZip(
  entries: ReadonlyArray<ZipEntryFixture>,
  options: Readonly<{ forceZip64?: boolean }> = {},
): Promise<Buffer> {
  const zip = new YazlZipFile();
  for (const entry of entries) {
    zip.addBuffer(entry.bytes, entry.path, {
      compress: true,
      compressionLevel: 6,
      forceDosTimestamp: true,
      mtime: FIXED_MTIME,
      mode: entry.mode ?? 0o100600,
    });
  }
  zip.end({
    forceZip64Format: options.forceZip64 ?? false,
    comment: "",
  });
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream as Readable) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

function archiveEntries(
  manifest: AssetReleaseManifestV2,
  bytesByPath: ReadonlyMap<string, Buffer>,
): ZipEntryFixture[] {
  return manifest.assets
    .map((asset) => ({
      path: asset.output.path,
      bytes: bytesByPath.get(asset.output.path)!,
    }))
    .sort((left, right) => (left.path < right.path ? -1 : 1));
}

function fixedContract(manifest: AssetReleaseManifestV2, archive: Buffer) {
  const packHash = sha256(archive);
  const uniqueOutputs = new Map(
    manifest.assets.map((asset) => [asset.output.path, asset.output] as const),
  );
  const path = `/tokenmonster/characters/v1/packs/${manifest.releaseId}/${packHash}.zip`;
  return {
    descriptor: {
      schemaVersion: ASSET_PACK_DESCRIPTOR_SCHEMA_VERSION,
      releaseId: manifest.releaseId,
      releaseManifestSha256: computeAssetReleaseManifestV2Sha256(manifest),
      pack: {
        path,
        mediaType: "application/zip" as const,
        bytes: archive.length,
        sha256: packHash,
        entryCount: uniqueOutputs.size,
        extractedBytes: [...uniqueOutputs.values()].reduce(
          (total, output) => total + output.bytes,
          0,
        ),
      },
    },
    allowlist: {
      schemaVersion: ASSET_PACK_ALLOWLIST_SCHEMA_VERSION,
      origin: PRIVATE_ORIGIN,
      path,
    },
  };
}

class BufferBody implements AssetPackResponseBody {
  readonly #chunks: ReadonlyArray<Uint8Array>;
  readonly #failureIndex: number | null;

  public constructor(
    chunks: ReadonlyArray<Uint8Array>,
    failureIndex: number | null = null,
  ) {
    this.#chunks = chunks;
    this.#failureIndex = failureIndex;
  }

  public getReader(): AssetPackStreamReader {
    let index = 0;
    return {
      read: async () => {
        if (index === this.#failureIndex) throw new Error("private failure");
        const value = this.#chunks[index];
        index += 1;
        return value === undefined ? { done: true } : { done: false, value };
      },
      cancel: async () => undefined,
    };
  }
}

function responseFor(
  url: string,
  archive: Buffer,
  overrides: Partial<AssetPackFetchResponse> & {
    contentLength?: string | null;
    contentType?: string | null;
    contentEncoding?: string | null;
  } = {},
): AssetPackFetchResponse {
  const values = new Map<string, string>();
  const contentLength = overrides.contentLength ?? String(archive.length);
  const contentType = overrides.contentType ?? "application/zip";
  const contentEncoding = overrides.contentEncoding ?? null;
  if (contentLength !== null) values.set("content-length", contentLength);
  if (contentType !== null) values.set("content-type", contentType);
  if (contentEncoding !== null) values.set("content-encoding", contentEncoding);
  const status = overrides.status ?? 200;
  return {
    ok: overrides.ok ?? (status >= 200 && status <= 299),
    status,
    redirected: overrides.redirected ?? false,
    url: overrides.url ?? url,
    headers:
      overrides.headers ??
      ({
        get: (name: string) => values.get(name.toLowerCase()) ?? null,
      } as const),
    body: overrides.body ?? new BufferBody([archive]),
  };
}

async function freshCache(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tokenmonster-fixed-pack-"));
  temporaryDirectories.push(root);
  return join(root, "asset-cache");
}

function expectPackError(error: unknown, code: AssetPackError["code"]): void {
  expect(error).toBeInstanceOf(AssetPackError);
  expect((error as AssetPackError).code).toBe(code);
  expect((error as Error).message).not.toContain(PRIVATE_ORIGIN);
}

async function stagingResidue(cacheDirectory: string): Promise<string[]> {
  try {
    return (await readdir(cacheDirectory)).filter((name) =>
      name.startsWith(".asset-pack-"),
    );
  } catch {
    return [];
  }
}

const CRASHED_OWNER_ID = "10000000-0000-4000-8000-000000000001";
const INVALID_MARKER_OWNER_ID = "20000000-0000-4000-8000-000000000002";

async function writeOwnedCrashResidue(
  cacheDirectory: string,
  releaseId: string,
  packSha256: string,
  options: Readonly<{ stage?: boolean }> = {},
): Promise<
  Readonly<{ stageName: string; stagePath: string; lockPath: string }>
> {
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const stageName = `.asset-pack-stage-v1-${CRASHED_OWNER_ID}`;
  const stagePath = join(cacheDirectory, stageName);
  if (options.stage !== false) {
    await mkdir(stagePath, { mode: 0o700 });
    await writeFile(
      join(stagePath, ".asset-pack-stage-owner-v1.json"),
      `${JSON.stringify({
        schemaVersion: "1",
        kind: "fixed-asset-pack-stage",
        ownerId: CRASHED_OWNER_ID,
        stageName,
        releaseId,
        packSha256,
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(join(stagePath, "interrupted-pack.zip"), "partial", {
      flag: "wx",
      mode: 0o600,
    });
  }
  const lockPath = join(cacheDirectory, ".asset-pack-install.lock");
  await writeFile(
    lockPath,
    `${JSON.stringify({
      schemaVersion: "1",
      kind: "fixed-asset-pack-lock",
      ownerId: CRASHED_OWNER_ID,
      stageName,
      releaseId,
      packSha256,
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return Object.freeze({ stageName, stagePath, lockPath });
}

function replaceAllExact(
  archive: Buffer,
  original: string,
  replacement: string,
): Buffer {
  expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
  const result = Buffer.from(archive);
  const needle = Buffer.from(original);
  const replacementBytes = Buffer.from(replacement);
  let replacements = 0;
  for (let offset = 0; offset <= result.length - needle.length; offset += 1) {
    if (!result.subarray(offset, offset + needle.length).equals(needle))
      continue;
    replacementBytes.copy(result, offset);
    replacements += 1;
    offset += needle.length - 1;
  }
  expect(replacements).toBe(2);
  return result;
}

function setZipFlags(archive: Buffer, flags: number): Buffer {
  const result = Buffer.from(archive);
  let localHeaders = 0;
  let centralHeaders = 0;
  for (let offset = 0; offset <= result.length - 10; offset += 1) {
    const signature = result.readUInt32LE(offset);
    if (signature === 0x04034b50) {
      result.writeUInt16LE(result.readUInt16LE(offset + 6) | flags, offset + 6);
      localHeaders += 1;
    } else if (signature === 0x02014b50) {
      result.writeUInt16LE(result.readUInt16LE(offset + 8) | flags, offset + 8);
      centralHeaders += 1;
    }
  }
  expect(localHeaders).toBeGreaterThan(0);
  expect(centralHeaders).toBe(localHeaders);
  return result;
}

describe("privacy-safe fixed asset pack", () => {
  it("plans and installs exactly one fixed request in canonical entry order", async () => {
    const objects = [packObject("avatar"), packObject("outfit")];
    const manifest = releaseManifest(objects);
    const bytesByPath = new Map(objects.map((item) => [item.path, item.bytes]));
    const archive = await createZip(archiveEntries(manifest, bytesByPath));
    const contract = fixedContract(manifest, archive);
    const plan = planFixedAssetPack({
      releaseManifest: manifest,
      ...contract,
    });
    const cacheDirectory = await freshCache();
    const calls: Array<
      Readonly<{ url: string; init: AssetPackFetchRequestInit }>
    > = [];
    const fetch: AssetPackFetch = async (url, init) => {
      calls.push({ url, init });
      return responseFor(url, archive);
    };

    const installed = await installFixedAssetPack({
      releaseManifest: manifest,
      ...contract,
      cacheDirectory,
      fetch,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${PRIVATE_ORIGIN}${contract.allowlist.path}`);
    expect(new URL(calls[0]!.url).search).toBe("");
    expect(new URL(calls[0]!.url).username).toBe("");
    expect(new URL(calls[0]!.url).password).toBe("");
    expect({ ...calls[0]!.init, signal: undefined }).toEqual({
      method: "GET",
      redirect: "error",
      credentials: "omit",
      referrer: "",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      headers: {
        Accept: "application/zip",
        "Accept-Encoding": "identity",
      },
      signal: undefined,
    });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(installed.entryPaths).toEqual([...plan.entryPaths]);
    expect(installed.entryPaths).toEqual([...installed.entryPaths].sort());
    for (const entryPath of installed.entryPaths) {
      const expected = bytesByPath.get(entryPath)!;
      const cachePath = join(cacheDirectory, basename(entryPath));
      expect(await readFile(cachePath)).toEqual(expected);
      expect((await lstat(cachePath)).mode & 0o777).toBe(0o600);
    }
    expect((await lstat(cacheDirectory)).mode & 0o777).toBe(0o700);
    expect(await stagingResidue(cacheDirectory)).toEqual([]);
  });

  it("cannot accept local state and yields identical request/order for varied canaries", async () => {
    const objects = [packObject("avatar"), packObject("outfit")];
    const manifest = releaseManifest(objects);
    const bytesByPath = new Map(objects.map((item) => [item.path, item.bytes]));
    const archive = await createZip(archiveEntries(manifest, bytesByPath));
    const contract = fixedContract(manifest, archive);
    const canaries = [
      { character: "chatgpt", unlocked: true, theme: "tech", today: 9_999 },
      { character: "glm", unlocked: false, pose: "error", trigger: "quiet" },
      { character: null, usage: 0, voice: false },
    ] as const;
    const plans = canaries.map((canary) => {
      expect(canary).toBeDefined();
      return planFixedAssetPack({ releaseManifest: manifest, ...contract });
    });
    expect(new Set(plans.map((plan) => JSON.stringify(plan))).size).toBe(1);
    expect(() =>
      planFixedAssetPack({
        releaseManifest: manifest,
        ...contract,
        localState: canaries[0],
      } as never),
    ).toThrowError(AssetPackError);

    const requests: Array<Readonly<{ url: string; init: unknown }>> = [];
    for (const canary of canaries.slice(0, 2)) {
      expect(canary).toBeDefined();
      const cacheDirectory = await freshCache();
      await installFixedAssetPack({
        releaseManifest: manifest,
        ...contract,
        cacheDirectory,
        fetch: async (url, init) => {
          requests.push({
            url,
            init: { ...init, signal: "fixed-signal-slot" },
          });
          return responseFor(url, archive);
        },
      });
    }
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(plans[0]?.entryPaths).toEqual(plans[1]?.entryPaths);
  });

  it("serializes two cache publishers so one cannot adopt an inode another rolls back", async () => {
    const objects = [packObject("avatar"), packObject("outfit")];
    const manifest = releaseManifest(objects);
    const bytesByPath = new Map(objects.map((item) => [item.path, item.bytes]));
    const archive = await createZip(archiveEntries(manifest, bytesByPath));
    const contract = fixedContract(manifest, archive);
    const cacheDirectory = await freshCache();
    await mkdir(cacheDirectory, { recursive: true });
    const lockPath = join(cacheDirectory, ".asset-pack-install.lock");
    await writeFile(lockPath, "external active publisher\n", {
      flag: "wx",
      mode: 0o600,
    });

    let fetchCalls = 0;
    let settled = 0;
    const startInstall = () =>
      installFixedAssetPack({
        releaseManifest: manifest,
        ...contract,
        cacheDirectory,
        fetch: async (url) => {
          fetchCalls += 1;
          return responseFor(url, archive);
        },
      }).finally(() => {
        settled += 1;
      });
    const first = startInstall();
    const second = startInstall();

    const waitDeadline = Date.now() + 1_000;
    while (fetchCalls < 1 && Date.now() < waitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(fetchCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(0);

    await unlink(lockPath);
    const installed = await Promise.all([first, second]);
    expect(fetchCalls).toBe(2);
    expect(installed[0]?.entryPaths).toEqual(installed[1]?.entryPaths);
    for (const entryPath of installed[0]!.entryPaths) {
      expect(await readFile(join(cacheDirectory, basename(entryPath)))).toEqual(
        bytesByPath.get(entryPath),
      );
    }
    expect(await stagingResidue(cacheDirectory)).toEqual([]);
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers only strictly marked stage and lock residue after a process crash", async () => {
    const objects = [packObject("avatar"), packObject("outfit")];
    const manifest = releaseManifest(objects);
    const bytesByPath = new Map(objects.map((item) => [item.path, item.bytes]));
    const archive = await createZip(archiveEntries(manifest, bytesByPath));
    const contract = fixedContract(manifest, archive);
    const cacheDirectory = await freshCache();
    const crashed = await writeOwnedCrashResidue(
      cacheDirectory,
      manifest.releaseId,
      contract.descriptor.pack.sha256,
    );
    const unrelatedPath = join(cacheDirectory, "player-note.keep");
    await writeFile(unrelatedPath, "keep me", { mode: 0o600 });
    const invalidStageName = `.asset-pack-stage-v1-${INVALID_MARKER_OWNER_ID}`;
    const invalidStagePath = join(cacheDirectory, invalidStageName);
    await mkdir(invalidStagePath, { mode: 0o700 });
    await writeFile(
      join(invalidStagePath, ".asset-pack-stage-owner-v1.json"),
      '{"schemaVersion":"wrong"}\n',
      { mode: 0o600 },
    );

    await installFixedAssetPack({
      releaseManifest: manifest,
      ...contract,
      cacheDirectory,
      fetch: async (url) => responseFor(url, archive),
    });

    await expect(lstat(crashed.stagePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(crashed.lockPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(unrelatedPath, "utf8")).toBe("keep me");
    expect(
      await readFile(
        join(invalidStagePath, ".asset-pack-stage-owner-v1.json"),
        "utf8",
      ),
    ).toBe('{"schemaVersion":"wrong"}\n');
    for (const entryPath of planFixedAssetPack({
      releaseManifest: manifest,
      ...contract,
    }).entryPaths) {
      expect(await readFile(join(cacheDirectory, basename(entryPath)))).toEqual(
        bytesByPath.get(entryPath),
      );
    }
  });

  it("serializes sixteen installers behind one strict stale lock and publishes one correct cache", async () => {
    const objects = [packObject("avatar"), packObject("outfit")];
    const manifest = releaseManifest(objects);
    const bytesByPath = new Map(objects.map((item) => [item.path, item.bytes]));
    const archive = await createZip(archiveEntries(manifest, bytesByPath));
    const contract = fixedContract(manifest, archive);
    const cacheDirectory = await freshCache();
    await writeOwnedCrashResidue(
      cacheDirectory,
      manifest.releaseId,
      contract.descriptor.pack.sha256,
    );

    let fetchCalls = 0;
    const outcomes = await Promise.allSettled(
      Array.from({ length: 16 }, () =>
        installFixedAssetPack({
          releaseManifest: manifest,
          ...contract,
          cacheDirectory,
          fetch: async (url) => {
            fetchCalls += 1;
            return responseFor(url, archive);
          },
        }),
      ),
    );

    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(
      true,
    );
    expect(fetchCalls).toBe(16);
    const expectedNames = objects
      .map((item) => basename(item.path))
      .sort();
    expect((await readdir(cacheDirectory)).sort()).toEqual(expectedNames);
    for (const object of objects) {
      expect(await readFile(join(cacheDirectory, basename(object.path)))).toEqual(
        object.bytes,
      );
    }
  });

  it("does not serialize installers for different canonical cache scopes", async () => {
    const object = packObject("avatar");
    const manifest = releaseManifest([object]);
    const archive = await createZip([
      { path: object.path, bytes: object.bytes },
    ]);
    const contract = fixedContract(manifest, archive);
    const cacheDirectories = await Promise.all([freshCache(), freshCache()]);
    let fetchesStarted = 0;
    let releaseFetches!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetches = resolve;
    });
    const installs = cacheDirectories.map((cacheDirectory) =>
      installFixedAssetPack({
        releaseManifest: manifest,
        ...contract,
        cacheDirectory,
        fetch: async (url) => {
          fetchesStarted += 1;
          await fetchGate;
          return responseFor(url, archive);
        },
      }),
    );

    const waitDeadline = Date.now() + 1_000;
    while (fetchesStarted < 2 && Date.now() < waitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const startedBeforeRelease = fetchesStarted;
    releaseFetches();
    await Promise.all(installs);

    expect(startedBeforeRelease).toBe(2);
    for (const cacheDirectory of cacheDirectories) {
      expect(await readFile(join(cacheDirectory, basename(object.path)))).toEqual(
        object.bytes,
      );
    }
  });

  it("recovers a lock-only crash window before publishing on restart", async () => {
    const object = packObject("avatar");
    const manifest = releaseManifest([object]);
    const archive = await createZip([
      { path: object.path, bytes: object.bytes },
    ]);
    const contract = fixedContract(manifest, archive);
    const cacheDirectory = await freshCache();
    const crashed = await writeOwnedCrashResidue(
      cacheDirectory,
      manifest.releaseId,
      contract.descriptor.pack.sha256,
      { stage: false },
    );

    await expect(
      installFixedAssetPack({
        releaseManifest: manifest,
        ...contract,
        cacheDirectory,
        fetch: async (url) => responseFor(url, archive),
      }),
    ).resolves.toMatchObject({ releaseId: manifest.releaseId });
    await expect(lstat(crashed.lockPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("clears owned crash residue even when restart is offline", async () => {
    const object = packObject("avatar");
    const manifest = releaseManifest([object]);
    const archive = await createZip([
      { path: object.path, bytes: object.bytes },
    ]);
    const contract = fixedContract(manifest, archive);
    const cacheDirectory = await freshCache();
    const crashed = await writeOwnedCrashResidue(
      cacheDirectory,
      manifest.releaseId,
      contract.descriptor.pack.sha256,
    );
    const unrelatedPath = join(cacheDirectory, "unrelated-cache-entry.keep");
    await writeFile(unrelatedPath, "preserved", { mode: 0o600 });

    await expect(
      installFixedAssetPack({
        releaseManifest: manifest,
        ...contract,
        cacheDirectory,
        fetch: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toMatchObject({ code: "network-error" });

    await expect(lstat(crashed.stagePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(crashed.lockPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(unrelatedPath, "utf8")).toBe("preserved");
  });

  it("offers marker-only local recovery without creating caches or accepting network hooks", async () => {
    const cacheDirectory = await freshCache();
    await expect(
      recoverFixedAssetPackCache({ cacheDirectory }),
    ).resolves.toBeUndefined();
    await expect(lstat(cacheDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    const crashed = await writeOwnedCrashResidue(
      cacheDirectory,
      "characters-2026.07.17",
      "f".repeat(64),
    );
    const unrelatedPath = join(cacheDirectory, "player-note.keep");
    const malformedStageName = `.asset-pack-stage-v1-${INVALID_MARKER_OWNER_ID}`;
    const malformedStagePath = join(cacheDirectory, malformedStageName);
    const lookalikePath = join(cacheDirectory, ".asset-pack-stage-v1-not-a-uuid");
    await writeFile(unrelatedPath, "preserved", { mode: 0o600 });
    await mkdir(malformedStagePath, { mode: 0o700 });
    await writeFile(
      join(malformedStagePath, ".asset-pack-stage-owner-v1.json"),
      '{"schemaVersion":"wrong"}\n',
      { mode: 0o600 },
    );
    await mkdir(lookalikePath, { mode: 0o700 });

    await recoverFixedAssetPackCache({ cacheDirectory });

    await expect(lstat(crashed.stagePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(crashed.lockPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(unrelatedPath, "utf8")).toBe("preserved");
    await expect(lstat(malformedStagePath)).resolves.toMatchObject({});
    await expect(lstat(lookalikePath)).resolves.toMatchObject({});
    await expect(
      recoverFixedAssetPackCache({
        cacheDirectory,
        fetch: async () => {
          throw new Error("must never run");
        },
      } as never),
    ).rejects.toMatchObject({ code: "invalid-configuration" });
  });

  it("queues startup recovery behind an active installer in the same cache", async () => {
    const object = packObject("avatar");
    const manifest = releaseManifest([object]);
    const archive = await createZip([
      { path: object.path, bytes: object.bytes },
    ]);
    const contract = fixedContract(manifest, archive);
    const cacheDirectory = await freshCache();
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const install = installFixedAssetPack({
      releaseManifest: manifest,
      ...contract,
      cacheDirectory,
      fetch: async (url) => {
        fetchStarted();
        await fetchGate;
        return responseFor(url, archive);
      },
    });
    await started;
    const activeStage = (await readdir(cacheDirectory)).find((name) =>
      name.startsWith(".asset-pack-stage-v1-"),
    );
    expect(activeStage).toBeDefined();

    let recoverySettled = false;
    const recovery = recoverFixedAssetPackCache({ cacheDirectory }).finally(
      () => {
        recoverySettled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(recoverySettled).toBe(false);
    await expect(lstat(join(cacheDirectory, activeStage!))).resolves.toMatchObject(
      {},
    );

    releaseFetch();
    await install;
    await recovery;
    expect(await stagingResidue(cacheDirectory)).toEqual([]);
  });

  it("never reclaims a stale lock pathname while two publishers wait", async () => {
    const objects = [packObject("avatar"), packObject("outfit")];
    const manifest = releaseManifest(objects);
    const bytesByPath = new Map(objects.map((item) => [item.path, item.bytes]));
    const archive = await createZip(archiveEntries(manifest, bytesByPath));
    const contract = fixedContract(manifest, archive);
    const cacheDirectory = await freshCache();
    await mkdir(cacheDirectory, { recursive: true });
    const lockPath = join(cacheDirectory, ".asset-pack-install.lock");
    const lockContents = "crashed content-blind publisher\n";
    await writeFile(lockPath, lockContents, { flag: "wx", mode: 0o600 });
    await utimes(lockPath, FIXED_MTIME, FIXED_MTIME);
    const lockBefore = await lstat(lockPath);

    let fetchCalls = 0;
    const controllers = [new AbortController(), new AbortController()];
    const installs = controllers.map((controller) =>
      installFixedAssetPack({
        releaseManifest: manifest,
        ...contract,
        cacheDirectory,
        signal: controller.signal,
        fetch: async (url) => {
          fetchCalls += 1;
          return responseFor(url, archive);
        },
      }),
    );

    const stagedFileNames = new Set([
      ...objects.map((item) => basename(item.path)),
    ]);
    const waitDeadline = Date.now() + 2_000;
    let readyStageCount = 0;
    while (Date.now() < waitDeadline) {
      const stageNames = (await readdir(cacheDirectory)).filter(
        (name) =>
          name.startsWith(".asset-pack-") &&
          name !== ".asset-pack-install.lock",
      );
      const readiness = await Promise.all(
        stageNames.map(async (name) => {
          const contents = await readdir(join(cacheDirectory, name));
          return [...stagedFileNames].every((fileName) =>
            contents.includes(fileName),
          );
        }),
      );
      readyStageCount = readiness.filter(Boolean).length;
      if (readyStageCount === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    controllers.forEach((controller) => controller.abort());
    const outcomes = await Promise.allSettled(installs);
    expect(fetchCalls).toBe(1);
    expect(readyStageCount).toBe(1);
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expectPackError(outcome.reason, "request-aborted");
      }
    }

    const lockAfter = await lstat(lockPath);
    expect(lockAfter.dev).toBe(lockBefore.dev);
    expect(lockAfter.ino).toBe(lockBefore.ino);
    expect(await readFile(lockPath, "utf8")).toBe(lockContents);
    expect(await stagingResidue(cacheDirectory)).toEqual([
      ".asset-pack-install.lock",
    ]);
    for (const entryPath of planFixedAssetPack({
      releaseManifest: manifest,
      ...contract,
    }).entryPaths) {
      await expect(
        lstat(join(cacheDirectory, basename(entryPath))),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("lets a second invocation publish only after the first has rolled back", async () => {
    const objects = [packObject("avatar"), packObject("outfit")];
    const manifest = releaseManifest(objects);
    const bytesByPath = new Map(objects.map((item) => [item.path, item.bytes]));
    const archive = await createZip(archiveEntries(manifest, bytesByPath));
    const contract = fixedContract(manifest, archive);
    const plan = planFixedAssetPack({ releaseManifest: manifest, ...contract });
    const cacheDirectory = await freshCache();
    await mkdir(cacheDirectory, { recursive: true });
    const lockPath = join(cacheDirectory, ".asset-pack-install.lock");
    await writeFile(lockPath, "external active publisher\n", {
      flag: "wx",
      mode: 0o600,
    });
    const blockingPath = join(cacheDirectory, basename(plan.entryPaths[1]!));
    await mkdir(blockingPath);

    let fetchCalls = 0;
    let releaseSecondFetch!: () => void;
    const secondFetchGate = new Promise<void>((resolve) => {
      releaseSecondFetch = resolve;
    });
    const startInstall = (index: number) =>
      installFixedAssetPack({
        releaseManifest: manifest,
        ...contract,
        cacheDirectory,
        fetch: async (url) => {
          fetchCalls += 1;
          if (fetchCalls === 2) await secondFetchGate;
          return responseFor(url, archive);
        },
      }).then(
        (value) => ({ status: "fulfilled" as const, index, value }),
        (error: unknown) => ({ status: "rejected" as const, index, error }),
      );
    const outcomes = [startInstall(0), startInstall(1)] as const;

    const waitDeadline = Date.now() + 1_000;
    while (fetchCalls < 1 && Date.now() < waitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(fetchCalls).toBe(1);
    await unlink(lockPath);

    // Cache canonicalization happens before the keyed mutex, so either caller
    // may become the first publisher regardless of invocation order.
    const firstOutcome = await Promise.race(outcomes);
    expect(firstOutcome.status).toBe("rejected");
    if (firstOutcome.status === "rejected") {
      expectPackError(firstOutcome.error, "cache-write-failed");
    }
    await rm(blockingPath, { recursive: true });
    releaseSecondFetch();
    const completed = await Promise.all(outcomes);
    expect(fetchCalls).toBe(2);
    expect(completed.filter((item) => item.status === "rejected")).toHaveLength(
      1,
    );
    expect(
      completed.filter((item) => item.status === "fulfilled"),
    ).toHaveLength(1);
    for (const entryPath of plan.entryPaths) {
      expect(await readFile(join(cacheDirectory, basename(entryPath)))).toEqual(
        bytesByPath.get(entryPath),
      );
    }
    expect(await stagingResidue(cacheDirectory)).toEqual([]);
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the transport primitive off the main runtime import", () => {
    expect("installFixedAssetPack" in charactersMain).toBe(false);
    expect("planFixedAssetPack" in charactersMain).toBe(false);
    expect("recoverFixedAssetPackCache" in charactersMain).toBe(false);
  });

  it.each([
    ["non-HTTPS origin", { origin: "http://assets.example.test" }],
    ["origin credentials", { origin: "https://user@assets.example.test" }],
    ["origin path", { origin: "https://assets.example.test/base" }],
    ["query", { pathSuffix: "?character=glm" }],
    ["fragment", { pathSuffix: "#voice" }],
  ])("rejects %s before issuing a request", async (_label, mutation) => {
    const object = packObject("avatar");
    const manifest = releaseManifest([object]);
    const archive = await createZip([
      { path: object.path, bytes: object.bytes },
    ]);
    const contract = fixedContract(manifest, archive);
    const cacheDirectory = await freshCache();
    let calls = 0;
    const allowlist = {
      ...contract.allowlist,
      ...("origin" in mutation ? { origin: mutation.origin } : {}),
      ...(!("pathSuffix" in mutation)
        ? {}
        : { path: `${contract.allowlist.path}${mutation.pathSuffix}` }),
    };
    await expect(
      installFixedAssetPack({
        releaseManifest: manifest,
        descriptor: contract.descriptor,
        allowlist,
        cacheDirectory,
        fetch: async (url) => {
          calls += 1;
          return responseFor(url, archive);
        },
      }),
    ).rejects.toBeInstanceOf(AssetPackError);
    expect(calls).toBe(0);
  });

  it("rejects a mismatched manifest, allowlisted path, and explicit caps before fetch", async () => {
    const object = packObject("avatar");
    const manifest = releaseManifest([object]);
    const archive = await createZip([
      { path: object.path, bytes: object.bytes },
    ]);
    const contract = fixedContract(manifest, archive);
    const cacheDirectory = await freshCache();
    let calls = 0;
    const fetch: AssetPackFetch = async (url) => {
      calls += 1;
      return responseFor(url, archive);
    };
    const invalidInputs = [
      {
        descriptor: {
          ...contract.descriptor,
          releaseManifestSha256: "0".repeat(64),
        },
        allowlist: contract.allowlist,
      },
      {
        descriptor: contract.descriptor,
        allowlist: {
          ...contract.allowlist,
          path: contract.allowlist.path.replace("/packs/", "/packs-x/"),
        },
      },
      {
        descriptor: {
          ...contract.descriptor,
          pack: {
            ...contract.descriptor.pack,
            bytes: MAX_ASSET_PACK_TRANSFER_BYTES + 1,
          },
        },
        allowlist: contract.allowlist,
      },
      {
        descriptor: {
          ...contract.descriptor,
          pack: {
            ...contract.descriptor.pack,
            entryCount: MAX_ASSET_PACK_ENTRIES + 1,
          },
        },
        allowlist: contract.allowlist,
      },
      {
        descriptor: {
          ...contract.descriptor,
          pack: {
            ...contract.descriptor.pack,
            extractedBytes: MAX_ASSET_PACK_EXTRACTED_BYTES + 1,
          },
        },
        allowlist: contract.allowlist,
      },
    ];
    for (const invalid of invalidInputs) {
      await expect(
        installFixedAssetPack({
          releaseManifest: manifest,
          ...invalid,
          cacheDirectory,
          fetch,
        }),
      ).rejects.toBeInstanceOf(AssetPackError);
    }
    expect(calls).toBe(0);
  });

  it("rejects redirects without making a follow-up request", async () => {
    const object = packObject("avatar");
    const manifest = releaseManifest([object]);
    const archive = await createZip([
      { path: object.path, bytes: object.bytes },
    ]);
    const contract = fixedContract(manifest, archive);
    const cacheDirectory = await freshCache();
    let calls = 0;
    const capturedInits: AssetPackFetchRequestInit[] = [];
    try {
      await installFixedAssetPack({
        releaseManifest: manifest,
        ...contract,
        cacheDirectory,
        fetch: async (url, init) => {
          calls += 1;
          capturedInits.push(init);
          return responseFor(url, archive, {
            status: 302,
            ok: false,
            url: `${PRIVATE_ORIGIN}/other.zip`,
          });
        },
      });
      throw new Error("expected rejection");
    } catch (error) {
      expectPackError(error, "redirect-rejected");
    }
    expect(calls).toBe(1);
    expect(capturedInits[0]?.redirect).toBe("error");
    expect(await stagingResidue(cacheDirectory)).toEqual([]);
  });

  it("verifies the complete pack hash before opening the ZIP", async () => {
    const object = packObject("avatar");
    const manifest = releaseManifest([object]);
    const archive = await createZip([
      { path: object.path, bytes: object.bytes },
    ]);
    const contract = fixedContract(manifest, archive);
    const corrupt = Buffer.from(archive);
    corrupt.writeUInt8(corrupt.readUInt8(0) ^ 0xff, 0);
    const cacheDirectory = await freshCache();
    try {
      await installFixedAssetPack({
        releaseManifest: manifest,
        ...contract,
        cacheDirectory,
        fetch: async (url) =>
          responseFor(url, corrupt, { contentLength: String(archive.length) }),
      });
      throw new Error("expected rejection");
    } catch (error) {
      expectPackError(error, "pack-integrity-failed");
    }
    expect(await readdir(cacheDirectory)).toEqual([]);
  });

  it.each([
    ["declared transfer", "declared"],
    ["streamed transfer", "stream"],
    ["archive entry", "entry"],
  ])("rejects an oversized %s and cleans staging", async (_label, kind) => {
    const object = packObject("avatar");
    const manifest = releaseManifest([object]);
    const validArchive = await createZip([
      { path: object.path, bytes: object.bytes },
    ]);
    let archive = validArchive;
    if (kind === "entry") {
      archive = await createZip([
        {
          path: object.path,
          bytes: Buffer.concat([object.bytes, Buffer.from("x")]),
        },
      ]);
    }
    const contract = fixedContract(manifest, archive);
    const cacheDirectory = await freshCache();
    let error: unknown;
    try {
      await installFixedAssetPack({
        releaseManifest: manifest,
        ...contract,
        cacheDirectory,
        fetch: async (url) => {
          if (kind === "declared") {
            return responseFor(url, archive, {
              contentLength: String(MAX_ASSET_PACK_TRANSFER_BYTES + 1),
            });
          }
          if (kind === "stream") {
            return responseFor(url, archive, {
              body: new BufferBody([archive, Buffer.from("extra")]),
              contentLength: null,
            });
          }
          return responseFor(url, archive);
        },
      });
    } catch (caught) {
      error = caught;
    }
    expectPackError(
      error,
      kind === "entry" ? "archive-rejected" : "transfer-limit-exceeded",
    );
    expect(await stagingResidue(cacheDirectory)).toEqual([]);
    expect(await readdir(cacheDirectory)).toEqual([]);
  });

  it("aborts a stalled request, times out independently, and removes temp files", async () => {
    const object = packObject("avatar");
    const manifest = releaseManifest([object]);
    const archive = await createZip([
      { path: object.path, bytes: object.bytes },
    ]);
    const contract = fixedContract(manifest, archive);

    const preAbortedCache = await freshCache();
    const preAbortedController = new AbortController();
    preAbortedController.abort();
    let preAbortedCalls = 0;
    await expect(
      installFixedAssetPack({
        releaseManifest: manifest,
        ...contract,
        cacheDirectory: preAbortedCache,
        signal: preAbortedController.signal,
        fetch: async (url) => {
          preAbortedCalls += 1;
          return responseFor(url, archive);
        },
      }),
    ).rejects.toMatchObject({ code: "request-aborted" });
    expect(preAbortedCalls).toBe(0);

    const callerCache = await freshCache();
    const callerController = new AbortController();
    let callerCalls = 0;
    let markCallerStarted!: () => void;
    const callerStarted = new Promise<void>((resolve) => {
      markCallerStarted = resolve;
    });
    const callerPromise = installFixedAssetPack({
      releaseManifest: manifest,
      ...contract,
      cacheDirectory: callerCache,
      signal: callerController.signal,
      fetch: async () => {
        callerCalls += 1;
        markCallerStarted();
        return new Promise<AssetPackFetchResponse>(() => undefined);
      },
    });
    await callerStarted;
    callerController.abort();
    await expect(callerPromise).rejects.toMatchObject({
      code: "request-aborted",
    });
    expect(callerCalls).toBe(1);
    expect(await stagingResidue(callerCache)).toEqual([]);

    const timeoutCache = await freshCache();
    const timeoutSignals: AbortSignal[] = [];
    const timeoutPromise = installFixedAssetPack({
      releaseManifest: manifest,
      ...contract,
      cacheDirectory: timeoutCache,
      timeoutMs: 5,
      fetch: async (_url, init) => {
        timeoutSignals.push(init.signal);
        return new Promise<AssetPackFetchResponse>(() => undefined);
      },
    });
    await expect(timeoutPromise).rejects.toMatchObject({
      code: "request-timeout",
    });
    expect(timeoutSignals[0]?.aborted).toBe(true);
    expect(await stagingResidue(timeoutCache)).toEqual([]);
  });

  it("rejects a partial response body and does not leave a partial pack", async () => {
    const object = packObject("avatar");
    const manifest = releaseManifest([object]);
    const archive = await createZip([
      { path: object.path, bytes: object.bytes },
    ]);
    const contract = fixedContract(manifest, archive);
    const cacheDirectory = await freshCache();
    await expect(
      installFixedAssetPack({
        releaseManifest: manifest,
        ...contract,
        cacheDirectory,
        fetch: async (url) =>
          responseFor(url, archive, {
            body: new BufferBody([archive.subarray(0, 20)], 1),
            contentLength: null,
          }),
      }),
    ).rejects.toMatchObject({ code: "network-error" });
    expect(await readdir(cacheDirectory)).toEqual([]);
  });

  it.each([
    ["missing", "missing"],
    ["extra", "extra"],
    ["duplicate", "duplicate"],
    ["wrong order", "order"],
    ["wrong SHA-256", "sha"],
  ])("rejects %s archive entries", async (_label, kind) => {
    const objects = [packObject("avatar"), packObject("outfit")];
    const manifest = releaseManifest(objects);
    const valid = objects
      .map((item) => ({ path: item.path, bytes: item.bytes }))
      .sort((left, right) => (left.path < right.path ? -1 : 1));
    let entries: ZipEntryFixture[];
    switch (kind) {
      case "missing":
        entries = valid.slice(0, 1);
        break;
      case "extra":
        entries = [
          ...valid,
          {
            path: "objects/" + "f".repeat(64) + ".png",
            bytes: pngBytes("extra"),
          },
        ];
        break;
      case "duplicate":
        entries = [valid[0]!, { ...valid[0]! }];
        break;
      case "order":
        entries = [...valid].reverse();
        break;
      case "sha":
        entries = valid.map((entry, index) =>
          index === 0
            ? {
                ...entry,
                bytes: Buffer.concat([
                  entry.bytes.subarray(0, entry.bytes.length - 1),
                  Buffer.from([
                    (entry.bytes.readUInt8(entry.bytes.length - 1) + 1) & 0xff,
                  ]),
                ]),
              }
            : entry,
        );
        break;
      default:
        throw new Error("unreachable fixture");
    }
    const archive = await createZip(entries);
    const contract = fixedContract(manifest, archive);
    const cacheDirectory = await freshCache();
    await expect(
      installFixedAssetPack({
        releaseManifest: manifest,
        ...contract,
        cacheDirectory,
        fetch: async (url) => responseFor(url, archive),
      }),
    ).rejects.toMatchObject({ code: "archive-rejected" });
    expect(await readdir(cacheDirectory)).toEqual([]);
  });

  it("rejects wrong media magic even when the entry bytes and SHA-256 match", async () => {
    const bytes = Buffer.alloc(pngBytes("avatar").length, 1);
    const object = Object.freeze({
      bytes,
      path: `objects/${sha256(bytes)}.png`,
      sha256: sha256(bytes),
    });
    const manifest = releaseManifest([object]);
    const archive = await createZip([{ path: object.path, bytes }]);
    const contract = fixedContract(manifest, archive);
    const cacheDirectory = await freshCache();
    await expect(
      installFixedAssetPack({
        releaseManifest: manifest,
        ...contract,
        cacheDirectory,
        fetch: async (url) => responseFor(url, archive),
      }),
    ).rejects.toMatchObject({ code: "archive-rejected" });
    expect(await readdir(cacheDirectory)).toEqual([]);
  });

  it.each([
    ["traversal", "traversal"],
    ["absolute path", "absolute"],
    ["backslash path", "backslash"],
    ["encrypted flag", "encrypted"],
    ["data descriptor flag", "descriptor"],
  ])("rejects a ZIP %s", async (_label, kind) => {
    const object = packObject("avatar");
    const manifest = releaseManifest([object]);
    let archive = await createZip([{ path: object.path, bytes: object.bytes }]);
    if (kind === "traversal") {
      archive = replaceAllExact(
        archive,
        object.path,
        `../${"a".repeat(object.path.length - 7)}.png`,
      );
    } else if (kind === "absolute") {
      archive = replaceAllExact(
        archive,
        object.path,
        `/${"a".repeat(object.path.length - 5)}.png`,
      );
    } else if (kind === "backslash") {
      archive = replaceAllExact(
        archive,
        object.path,
        object.path.replace("/", "\\"),
      );
    } else if (kind === "encrypted") {
      archive = setZipFlags(archive, 0x0001);
    } else {
      archive = setZipFlags(archive, 0x0008);
    }
    const contract = fixedContract(manifest, archive);
    const cacheDirectory = await freshCache();
    await expect(
      installFixedAssetPack({
        releaseManifest: manifest,
        ...contract,
        cacheDirectory,
        fetch: async (url) => responseFor(url, archive),
      }),
    ).rejects.toMatchObject({ code: "archive-rejected" });
    expect(await readdir(cacheDirectory)).toEqual([]);
  });

  it("rejects ZIP64 and Unix symlink entries", async () => {
    const object = packObject("avatar");
    const manifest = releaseManifest([object]);
    const variants = [
      await createZip([{ path: object.path, bytes: object.bytes }], {
        forceZip64: true,
      }),
      await createZip([
        { path: object.path, bytes: object.bytes, mode: 0o120777 },
      ]),
    ];
    for (const archive of variants) {
      const contract = fixedContract(manifest, archive);
      const cacheDirectory = await freshCache();
      await expect(
        installFixedAssetPack({
          releaseManifest: manifest,
          ...contract,
          cacheDirectory,
          fetch: async (url) => responseFor(url, archive),
        }),
      ).rejects.toMatchObject({ code: "archive-rejected" });
      expect(await readdir(cacheDirectory)).toEqual([]);
    }
  });

  it("rolls back an already-published entry after a later cache failure", async () => {
    const objects = [packObject("avatar"), packObject("outfit")];
    const manifest = releaseManifest(objects);
    const bytesByPath = new Map(objects.map((item) => [item.path, item.bytes]));
    const archive = await createZip(archiveEntries(manifest, bytesByPath));
    const contract = fixedContract(manifest, archive);
    const plan = planFixedAssetPack({ releaseManifest: manifest, ...contract });
    const cacheDirectory = await freshCache();
    await mkdir(cacheDirectory, { recursive: true });
    const firstPath = join(cacheDirectory, basename(plan.entryPaths[0]!));
    const blockingPath = join(cacheDirectory, basename(plan.entryPaths[1]!));
    await mkdir(blockingPath);

    await expect(
      installFixedAssetPack({
        releaseManifest: manifest,
        ...contract,
        cacheDirectory,
        fetch: async (url) => responseFor(url, archive),
      }),
    ).rejects.toMatchObject({ code: "cache-write-failed" });
    await expect(lstat(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(blockingPath)).isDirectory()).toBe(true);
    expect(await stagingResidue(cacheDirectory)).toEqual([]);
  });

  it("reverifies an existing cache entry and replaces corrupt regular bytes", async () => {
    const object = packObject("avatar");
    const manifest = releaseManifest([object]);
    const archive = await createZip([
      { path: object.path, bytes: object.bytes },
    ]);
    const contract = fixedContract(manifest, archive);
    const cacheDirectory = await freshCache();
    await mkdir(cacheDirectory, { recursive: true });
    const cachePath = join(cacheDirectory, basename(object.path));
    await writeFile(cachePath, Buffer.alloc(object.bytes.length), {
      mode: 0o644,
    });
    await installFixedAssetPack({
      releaseManifest: manifest,
      ...contract,
      cacheDirectory,
      fetch: async (url) => responseFor(url, archive),
    });
    expect(await readFile(cachePath)).toEqual(object.bytes);
    expect((await lstat(cachePath)).mode & 0o777).toBe(0o600);
    expect(await stagingResidue(cacheDirectory)).toEqual([]);
  });
});
