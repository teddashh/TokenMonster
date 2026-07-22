import type { AssetManifest } from "./asset-manifest.js";
import embeddedApprovedReleaseV2 from "./approved-release-v2.json" with {
  type: "json",
};
import embeddedAssetPackAllowlistV1 from "./approved-asset-pack-allowlist-v1.json" with {
  type: "json",
};
import embeddedAssetPackDescriptorV1 from "./approved-asset-pack-descriptor-v1.json" with {
  type: "json",
};
import {
  resolveApprovedAssetAuthority,
  resolveApprovedAssetPackAuthority,
  type ApprovedAssetPackConfiguration,
} from "./approved-authority.js";
import {
  installedEmbeddedStarterAssetDirectory,
  loadEmbeddedStarterAssetConfiguration,
  type EmbeddedStarterAssetConfiguration,
} from "./embedded-starter-assets.js";

/**
 * The generated release JSON beside this module is the rights authority slot.
 * A slot may be null only for an unconfigured fail-closed build; production
 * release policy pins the reviewed non-null bytes after every rights and
 * provenance gate passes. Repository schema-v1 JSON is pipeline input only
 * and is never consulted.
 */
export function getApprovedAssetManifest(): AssetManifest | null {
  return resolveApprovedAssetAuthority(embeddedApprovedReleaseV2);
}

/** Return a complete, immutable acquisition authority or fail closed. */
export function getApprovedAssetPackConfiguration(): ApprovedAssetPackConfiguration | null {
  return resolveApprovedAssetPackAuthority(
    embeddedApprovedReleaseV2,
    embeddedAssetPackDescriptorV1,
    embeddedAssetPackAllowlistV1,
  );
}

/** Return the exact built-in starter set, or fail closed in source builds. */
export function getEmbeddedStarterAssetConfiguration(): EmbeddedStarterAssetConfiguration | null {
  const approved = getApprovedAssetManifest();
  if (approved === null) return null;
  try {
    return loadEmbeddedStarterAssetConfiguration(
      approved,
      installedEmbeddedStarterAssetDirectory(),
    );
  } catch {
    return null;
  }
}

export type { ApprovedAssetPackConfiguration } from "./approved-authority.js";
export type { EmbeddedStarterAssetConfiguration } from "./embedded-starter-assets.js";
