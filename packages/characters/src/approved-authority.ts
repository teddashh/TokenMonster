import type { AssetManifest } from "./asset-manifest.js";
import {
  AssetPackAllowlistV1Schema,
  AssetPackDescriptorV1Schema,
  planFixedAssetPack,
  type AssetPackAllowlistV1,
  type AssetPackDescriptorV1,
} from "./asset-pack.js";
import {
  AssetReleaseManifestV2Schema,
  projectAssetReleaseManifestV2ToRuntimeManifest,
  type AssetReleaseManifestV2,
} from "./asset-release.js";

export interface ApprovedAssetPackConfiguration {
  readonly releaseManifest: AssetReleaseManifestV2;
  readonly descriptor: AssetPackDescriptorV1;
  readonly allowlist: AssetPackAllowlistV1;
}

/**
 * Resolve an embedded public authority without ever accepting schema-v1
 * integrity input. This module is intentionally not exported from the package
 * root; release entry points receive authority only through the zero-argument
 * getter in approved-manifest.ts.
 */
export function resolveApprovedAssetAuthority(
  authority: unknown,
): AssetManifest | null {
  const release = AssetReleaseManifestV2Schema.safeParse(authority);
  if (!release.success) return null;

  try {
    return projectAssetReleaseManifestV2ToRuntimeManifest(release.data);
  } catch {
    // A future projection invariant must fail to letter mode, never partially
    // expose an embedded association set.
    return null;
  }
}

/**
 * Join the three release-time authorities and prove their immutable binding.
 * A rights-approved v2 manifest alone never authorizes a network request.
 */
export function resolveApprovedAssetPackAuthority(
  authority: unknown,
  descriptorInput: unknown,
  allowlistInput: unknown,
): ApprovedAssetPackConfiguration | null {
  const release = AssetReleaseManifestV2Schema.safeParse(authority);
  const descriptor = AssetPackDescriptorV1Schema.safeParse(descriptorInput);
  const allowlist = AssetPackAllowlistV1Schema.safeParse(allowlistInput);
  if (!release.success || !descriptor.success || !allowlist.success) {
    return null;
  }
  try {
    planFixedAssetPack({
      releaseManifest: release.data,
      descriptor: descriptor.data,
      allowlist: allowlist.data,
    });
    projectAssetReleaseManifestV2ToRuntimeManifest(release.data);
    return Object.freeze({
      releaseManifest: release.data,
      descriptor: descriptor.data,
      allowlist: allowlist.data,
    });
  } catch {
    return null;
  }
}
