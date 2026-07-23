// Shared acquisition and extraction for the pinned embedded starter source
// pack. The CLI tarball staging and the desktop companion packaging both
// consume the same eight reviewed WebP objects, so the download pin, the
// bounded ZIP walk, and the per-object policy checks live here once.

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

import yauzl from "yauzl";

import {
  PUBLIC_EMBEDDED_STARTER_ASSETS,
  PUBLIC_EMBEDDED_STARTER_SOURCE_PACK,
  requirePublicEmbeddedStarterAsset,
} from "./public-artifact-policy.mjs";

function requirePinnedEmbeddedStarterPack(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== PUBLIC_EMBEDDED_STARTER_SOURCE_PACK.bytes ||
    createHash("sha256").update(bytes).digest("hex") !==
      PUBLIC_EMBEDDED_STARTER_SOURCE_PACK.sha256
  ) {
    throw new Error("Embedded starter source pack differs from policy");
  }
  return bytes;
}

async function readLocalEmbeddedStarterPack(path) {
  const before = await lstat(path);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size !== PUBLIC_EMBEDDED_STARTER_SOURCE_PACK.bytes
  ) {
    throw new Error(
      "The local embedded starter pack must be one exact physical file",
    );
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error("The local embedded starter pack changed while staging");
  }
  return requirePinnedEmbeddedStarterPack(bytes);
}

async function downloadEmbeddedStarterPack() {
  const response = await fetch(PUBLIC_EMBEDDED_STARTER_SOURCE_PACK.url, {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    referrer: "",
    referrerPolicy: "no-referrer",
    headers: {
      Accept: "application/zip",
      "Accept-Encoding": "identity",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || response.status !== 200 || response.body === null) {
    throw new Error("Could not fetch the pinned embedded starter source pack");
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    declaredLength !== String(PUBLIC_EMBEDDED_STARTER_SOURCE_PACK.bytes)
  ) {
    throw new Error("Embedded starter source pack has an unexpected length");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > PUBLIC_EMBEDDED_STARTER_SOURCE_PACK.bytes) {
      throw new Error("Embedded starter source pack exceeds its byte limit");
    }
    chunks.push(bytes);
  }
  return requirePinnedEmbeddedStarterPack(Buffer.concat(chunks, total));
}

/**
 * Read the pinned starter source pack, preferring an exact local copy when a
 * path is provided and downloading the pinned URL otherwise.
 */
export async function readEmbeddedStarterPack(localPath) {
  return localPath === null || localPath === undefined
    ? downloadEmbeddedStarterPack()
    : readLocalEmbeddedStarterPack(localPath);
}

function openZipBuffer(bytes) {
  return new Promise((resolvePromise, reject) => {
    yauzl.fromBuffer(
      bytes,
      {
        autoClose: false,
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error, zipFile) => {
        if (error !== null) reject(error);
        else resolvePromise(zipFile);
      },
    );
  });
}

function readZipEntry(zipFile, entry, maximumBytes) {
  return new Promise((resolvePromise, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error !== null) {
        reject(error);
        return;
      }
      const chunks = [];
      let total = 0;
      stream.on("data", (chunk) => {
        total += chunk.length;
        if (total > maximumBytes) {
          stream.destroy(new Error("Embedded starter ZIP entry is too large"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      stream.once("error", reject);
      stream.once("end", () => resolvePromise(Buffer.concat(chunks, total)));
    });
  });
}

/**
 * Extract and policy-verify the exact eight starter objects from the pinned
 * pack bytes. Resolves to policy assets paired with their verified contents;
 * rejects when the archive inventory differs from policy in any way.
 */
export async function extractEmbeddedStarterObjects(packBytes) {
  const expectedByObjectPath = new Map(
    PUBLIC_EMBEDDED_STARTER_ASSETS.map((asset) => [asset.objectPath, asset]),
  );
  const seen = new Set();
  const objects = [];
  const zipFile = await openZipBuffer(packBytes);
  try {
    await new Promise((resolvePromise, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        zipFile.close();
        reject(error);
      };
      zipFile.once("error", fail);
      zipFile.once("end", () => {
        if (settled) return;
        settled = true;
        if (
          seen.size !== PUBLIC_EMBEDDED_STARTER_ASSETS.length ||
          [...expectedByObjectPath.keys()].some((path) => !seen.has(path))
        ) {
          reject(new Error("Embedded starter ZIP inventory is incomplete"));
          return;
        }
        resolvePromise();
      });
      zipFile.on("entry", (entry) => {
        void (async () => {
          const expected = expectedByObjectPath.get(entry.fileName);
          if (
            expected === undefined ||
            seen.has(entry.fileName) ||
            entry.fileName.endsWith("/") ||
            entry.compressionMethod !== 0 ||
            entry.compressedSize !== expected.bytes ||
            entry.uncompressedSize !== expected.bytes ||
            (entry.generalPurposeBitFlag & 0x0001) !== 0
          ) {
            throw new Error(
              "Embedded starter ZIP inventory differs from policy",
            );
          }
          const contents = await readZipEntry(zipFile, entry, expected.bytes);
          requirePublicEmbeddedStarterAsset(expected.archiveEntry, contents);
          objects.push(Object.freeze({ asset: expected, contents }));
          seen.add(entry.fileName);
          zipFile.readEntry();
        })().catch(fail);
      });
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }
  return Object.freeze(objects);
}

/** Acquire the pinned pack and return the eight verified starter objects. */
export async function acquireEmbeddedStarterObjects(localPath) {
  return extractEmbeddedStarterObjects(
    await readEmbeddedStarterPack(localPath),
  );
}
