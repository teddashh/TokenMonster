import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_DIRECTORY = fileURLToPath(new URL("../dist/", import.meta.url));
const ASSET_MANIFEST_PATH = fileURLToPath(
  new URL(
    "../../../packages/characters/asset-manifest.json",
    import.meta.url,
  ),
);
const TEXT_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".txt"]);
const MEDIA_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".mp3",
  ".mp4",
  ".ogg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".wav",
  ".webm",
  ".webp",
]);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

function looksLikeRaster(bytes) {
  const header = bytes.subarray(0, 16);
  return (
    header.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
    header.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")) ||
    header.subarray(0, 6).toString("ascii") === "GIF87a" ||
    header.subarray(0, 6).toString("ascii") === "GIF89a" ||
    (header.subarray(0, 4).toString("ascii") === "RIFF" &&
      header.subarray(8, 12).toString("ascii") === "WEBP") ||
    header.subarray(4, 12).toString("ascii").startsWith("ftypavi")
  );
}

const assetManifest = JSON.parse(await readFile(ASSET_MANIFEST_PATH, "utf8"));
const assets = Array.isArray(assetManifest.assets) ? assetManifest.assets : [];
const approvedHashes = new Set(
  assets
    .filter((asset) => asset.releaseStatus === "approved")
    .map((asset) => asset.sha256),
);
const blockedAssets = assets.filter((asset) => asset.releaseStatus !== "approved");
const blockedHashes = new Set(blockedAssets.map((asset) => asset.sha256));
const forbiddenReleaseMarkers = [
  "asset-manifest.json",
  "data:image/",
  ...blockedAssets.flatMap((asset) => [asset.id, asset.sourcePath, asset.sha256]),
];

const files = await listFiles(OUTPUT_DIRECTORY);
for (const file of files) {
  const extension = extname(file).toLowerCase();
  const bytes = await readFile(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  if (blockedHashes.has(sha256)) {
    throw new Error(`Blocked character asset hash found in deploy build: ${file}`);
  }
  if (
    (MEDIA_EXTENSIONS.has(extension) || looksLikeRaster(bytes)) &&
    !approvedHashes.has(sha256)
  ) {
    throw new Error(`Unapproved media asset found in deploy build: ${file}`);
  }
  if (extension === ".map") {
    throw new Error(`Source map found in deploy build: ${file}`);
  }
  if (!TEXT_EXTENSIONS.has(extension)) {
    if (bytes.includes(0) && !approvedHashes.has(sha256)) {
      throw new Error(`Unknown binary asset found in deploy build: ${file}`);
    }
    continue;
  }

  const contents = bytes.toString("utf8");
  for (const marker of forbiddenReleaseMarkers) {
    if (typeof marker === "string" && marker.length > 0 && contents.includes(marker)) {
      throw new Error(`Blocked character asset marker found in deploy build: ${marker}`);
    }
  }
}
