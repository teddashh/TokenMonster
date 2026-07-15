import type { Plugin } from "vite";

export const runtimeExternal = (source: string): boolean =>
  source === "electron" || source.startsWith("node:");

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
      if (!id.replaceAll("\\", "/").endsWith("/src/preload/guards.cts")) {
        return null;
      }
      const first = code.indexOf(COMMONJS_GUARD_EXPORT);
      if (
        first === -1 ||
        first !== code.lastIndexOf(COMMONJS_GUARD_EXPORT) ||
        code.slice(first).trim() !== COMMONJS_GUARD_EXPORT
      ) {
        throw new Error("Preload guard export shape changed; packaging review required.");
      }
      return {
        code: `${code.slice(0, first)}${ESM_GUARD_EXPORT}\n`,
        map: null
      };
    }
  };
}
