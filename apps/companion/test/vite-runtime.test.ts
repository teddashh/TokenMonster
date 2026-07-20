import { describe, expect, it } from "vitest";

import {
  normalizePreloadGuardSource,
  runtimeExternal
} from "../vite.runtime.js";

const EXPECTED_EXPORT = `export = Object.freeze({
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

describe("preload guard export normalization", () => {
  it("accepts the unchanged shape with LF or CRLF source", () => {
    const lf = normalizePreloadGuardSource(`const canary = true;\n${EXPECTED_EXPORT}\n`);
    const crlf = normalizePreloadGuardSource(
      `const canary = true;\n${EXPECTED_EXPORT}\n`.replaceAll("\n", "\r\n")
    );
    expect(crlf).toEqual(lf);
    expect(crlf.code).not.toContain("\r");
    expect(crlf.code).toContain("export {\n  chatRequest,");
  });

  it("still rejects a mutated CRLF export surface", () => {
    const mutated = EXPECTED_EXPORT.replace(
      "  validatedCharacterId\n",
      "  unexpectedExport,\n  validatedCharacterId\n"
    ).replaceAll("\n", "\r\n");
    expect(() => normalizePreloadGuardSource(mutated)).toThrow(
      "Preload guard export shape changed; packaging review required."
    );
  });
});

describe("Electron runtime externals", () => {
  it("keeps both canonical and legacy Node builtin specifiers out of browser transforms", () => {
    for (const source of [
      "electron",
      "node:fs",
      "fs",
      "fs/promises",
      "stream",
      "util",
      "zlib"
    ]) {
      expect(runtimeExternal(source), source).toBe(true);
    }
    expect(runtimeExternal("@tokenmonster/characters")).toBe(false);
    expect(runtimeExternal("yauzl")).toBe(false);
  });
});
