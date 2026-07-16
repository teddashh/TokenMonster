import type { Plugin } from "vite";

export const runtimeExternal = (source: string): boolean =>
  source === "electron" || source.startsWith("node:");

function normalizedSource(code: string): string {
  return code.replace(/\r\n?/gu, "\n");
}

function normalizedModuleId(id: string): string {
  return id.replaceAll("\\", "/").split("?", 1)[0] ?? "";
}

const COMMONJS_GUARD_EXPORT = `export = Object.freeze({
  chatRequest,
  collectorScanRequest,
  configureRequest,
  contributionDeleteRequest,
  contributionDeletionStatusRequest,
  contributionEnableRequest,
  contributionPreviewRequest,
  contributionStopRequest,
  contributionSyncRequest,
  createInvokeGuard,
  fixedRequest,
  localSourceResetRequest,
  shareCardSaveRequest,
  usageInsightsRequest,
  validatedCharacterId
});`;

const ESM_GUARD_EXPORT = `export {
  chatRequest,
  collectorScanRequest,
  configureRequest,
  contributionDeleteRequest,
  contributionDeletionStatusRequest,
  contributionEnableRequest,
  contributionPreviewRequest,
  contributionStopRequest,
  contributionSyncRequest,
  createInvokeGuard,
  fixedRequest,
  localSourceResetRequest,
  shareCardSaveRequest,
  usageInsightsRequest,
  validatedCharacterId
};`;

export function normalizePreloadGuardExport(): Plugin {
  return {
    name: "tokenmonster-preload-guard-export",
    enforce: "pre",
    transform(code, id) {
      if (!normalizedModuleId(id).endsWith("/src/preload/guards.cts")) {
        return null;
      }
      return normalizePreloadGuardSource(code);
    }
  };
}

export function normalizePreloadGuardSource(code: string): Readonly<{
  code: string;
  map: null;
}> {
  const platformNeutralCode = normalizedSource(code);
  const first = platformNeutralCode.indexOf(COMMONJS_GUARD_EXPORT);
  if (
    first === -1 ||
    first !== platformNeutralCode.lastIndexOf(COMMONJS_GUARD_EXPORT) ||
    platformNeutralCode.slice(first).trim() !== COMMONJS_GUARD_EXPORT
  ) {
    throw new Error(
      "Preload guard export shape changed; packaging review required."
    );
  }
  return Object.freeze({
    code: `${platformNeutralCode.slice(0, first)}${ESM_GUARD_EXPORT}\n`,
    map: null
  });
}
