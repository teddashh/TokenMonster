import approvedManifestJson from "./approved-manifest.json" with { type: "json" };

import { parseAssetManifest, type AssetManifest } from "./asset-manifest.js";

/** Return the release-embedded, strictly validated asset allowlist. */
export function getApprovedAssetManifest(): AssetManifest | null {
  const embedded: unknown = approvedManifestJson;
  if (
    embedded === null ||
    (typeof embedded === "object" &&
      !Array.isArray(embedded) &&
      Reflect.ownKeys(embedded).length === 0)
  ) {
    return null;
  }
  return parseAssetManifest(embedded);
}
