export const SOURCE_COMPANION_VERSION: "0.1.0";
export const WINDOWS_RFC3161_TIMESTAMP_SERVER: string;

export function requireReleaseVersion(
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>
): string;

export function ciReleaseVersionForRunId(runId: string): string;

export function squirrelVersionFor(releaseVersion: string): string;

export function requireSquirrelReleaseEntry(
  parts: readonly unknown[],
  expected: Readonly<{
    fileName: string;
    byteSize: number;
    sha1: string;
  }>
): Readonly<{
  sha1: string;
  fileName: string;
  byteSize: number;
}>;

export function requireSignedWindowsSquirrelInventory(
  fileNames: readonly unknown[],
  fullPackageName: string
): readonly string[];

export function packageJsonWithReleaseVersion<
  PackageJson extends Record<string, unknown>
>(
  packageJson: PackageJson,
  releaseVersion: string
): Omit<PackageJson, "version"> & { version: string };

export function isWindowsSignablePath(path: string): boolean;

export interface AuthenticodeInspection {
  readonly status: unknown;
  readonly signerSubject: unknown;
  readonly signerThumbprint: unknown;
  readonly timestampSubject: unknown;
  readonly timestampThumbprint: unknown;
  readonly signatureContainerCount: unknown;
  readonly digestOids: unknown;
  readonly timestampAttributeOids: unknown;
  readonly productVersion: unknown;
  readonly fileVersion: unknown;
}

export interface AuthenticodeEvidence {
  readonly status: "Valid";
  readonly signerSubject: string;
  readonly signerThumbprint: string;
  readonly timestampPresent: true;
  readonly timestampSubject: string;
  readonly timestampThumbprint: string;
  readonly digestAlgorithm: "sha256";
  readonly digestOid: "2.16.840.1.101.3.4.2.1";
  readonly timestampProtocol: "RFC3161";
  readonly timestampAttributeOid: "1.3.6.1.4.1.311.3.3.1";
  readonly timestampServer: string;
  readonly productVersion: string | null;
  readonly fileVersion: string | null;
}

export function authenticodeEvidenceFromInspection(
  result: AuthenticodeInspection,
  expectedSignerSubject: string
): AuthenticodeEvidence;

export function requireWindowsSignerSubject(
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>
): string;

export interface WindowsSignOptions {
  readonly automaticallySelectCertificate: false;
  readonly debug: false;
  readonly description: "TokenMonster";
  readonly hashes: readonly ["sha256"];
  readonly signJavaScript: false;
  readonly timestampServer: string;
}

export function prepareWindowsSigningEnvironment(
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>
): {
  readonly expectedSignerSubject: string;
  readonly windowsSign: WindowsSignOptions;
};

export function environmentWithoutWindowsSigningSecrets(
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>
): Record<string, string | undefined>;
