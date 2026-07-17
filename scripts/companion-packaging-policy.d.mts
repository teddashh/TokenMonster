export const SIDECAR_ROOT_LOCK_PATH: "node_modules/tokentracker-cli";
export {
  SIDECAR_MAX_FILE_COUNT,
  SIDECAR_MAX_TOTAL_BYTES,
  SIDECAR_MAX_TREE_DEPTH
} from "../apps/companion/packaging/package-bounds.mjs";

export function resolveLockedDependency(
  packageLock: unknown,
  entryPath: string,
  dependency: string
): string | undefined;

export function sidecarDependencyClosure(
  packageLock: unknown,
  rootPath?: string
): string[];

export function declaredSidecarPackageFiles(
  packageDirectory: string,
  packageManifest: unknown
): Promise<string[]>;

export function stagedSidecarPackagePaths(
  targetDirectory: string
): Promise<string[]>;

export function packageNameFromLockPath(lockPath: string): string;

export interface CompanionFileEvidence {
  readonly bytes: number;
  readonly sha256: string;
}

export function assertSquirrelSidecarInventory(
  archiveFiles: ReadonlyMap<string, CompanionFileEvidence>,
  expectedSidecarInventory: ReadonlyMap<string, CompanionFileEvidence>,
  sidecarPrefix?: string
): number;
