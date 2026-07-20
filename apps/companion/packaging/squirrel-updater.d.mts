export interface SquirrelUpdaterBinding {
  readonly bytes: number;
  readonly sha256: string;
}

export const REVIEWED_SQUIRREL_UPDATER: Readonly<
  SquirrelUpdaterBinding & {
    readonly sourceBaseCommit: string;
    readonly sourceFixCommit: string;
    readonly sourceFixTree: string;
    readonly dependencyInventorySha256: string;
    readonly mergeInputInventorySha256: string;
    readonly integrationStatus: "reviewed-internal-candidate";
    readonly publicReleaseStatus: "blocked-pending-redistribution-and-native-install-review";
  }
>;

export function requireReviewedSquirrelReleaseMode(releaseMode: unknown): void;

export function verifyReviewedSquirrelUpdater(): Promise<
  Readonly<SquirrelUpdaterBinding & { path: string }>
>;

export function verifyElectronWinstallerVendor(): Promise<
  Readonly<{ directory: string; inventorySha256: string }>
>;

export function verifyReviewedSquirrelVendorOverlay(
  directory: string,
): Promise<Readonly<{ directory: string; updaterSha256: string }>>;

export function prepareReviewedSquirrelVendorOverlay(
  directory: string,
  releaseMode: unknown,
): Promise<Readonly<{ directory: string; updaterSha256: string }>>;
