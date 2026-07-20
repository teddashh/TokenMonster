import type { AssetManifest } from "./asset-manifest.js";
import embeddedApprovedReleaseV2 from "./approved-release-v2.json" with {
  type: "json",
};
import {
  resolveApprovedAssetAuthority,
  resolveApprovedAssetPackAuthority,
  type ApprovedAssetPackConfiguration,
} from "./approved-authority.js";

// These generated release constants deliberately stay null until the fixed
// archive is published and its exact descriptor/origin have been reviewed.
// Keeping them separate from the v2 rights authority prevents approved art by
// itself from enabling transport.
const embeddedAssetPackDescriptorV1: unknown = null;
const embeddedAssetPackAllowlistV1: unknown = null;

/**
 * The generated JSON beside this module is the only embedded public authority
 * slot. It defaults to null, so public builds stay letter-only until a
 * schema-v2 release manifest has passed every rights and provenance gate.
 * Repository schema-v1 JSON is pipeline input only and is never consulted.
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

export type { ApprovedAssetPackConfiguration } from "./approved-authority.js";
