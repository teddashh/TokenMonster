import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { PERMANENT_SIDECAR_COLLECTOR_IDENTITY_V2 } from "@tokenmonster/contracts";
import {
  SUPPORTED_TOKEN_TRACKER_VERSION,
  TOKEN_TRACKER_ADAPTER_VERSION,
} from "@tokenmonster/token-tracker-adapter";
import { PINNED_TOKEN_TRACKER_VERSION } from "@tokenmonster/token-tracker-runtime";

import { SIDECAR_CONTRIBUTION_COLLECTOR } from "../src/sidecar-contribution-projector.js";

const adapterManifest = JSON.parse(
  await readFile(
    new URL("../../../packages/token-tracker-adapter/package.json", import.meta.url),
    "utf8",
  ),
) as { readonly version?: string };

describe("permanent contribution collector drift guard", () => {
  it("keeps the wire authority, adapter compatibility, and runtime pin exact", () => {
    expect(SIDECAR_CONTRIBUTION_COLLECTOR).toBe(
      PERMANENT_SIDECAR_COLLECTOR_IDENTITY_V2,
    );
    expect(PERMANENT_SIDECAR_COLLECTOR_IDENTITY_V2).toEqual({
      kind: "tokentracker-sidecar",
      adapterVersion: TOKEN_TRACKER_ADAPTER_VERSION,
      sourceVersion: SUPPORTED_TOKEN_TRACKER_VERSION,
    });
    expect(SUPPORTED_TOKEN_TRACKER_VERSION).toBe(
      PINNED_TOKEN_TRACKER_VERSION,
    );
    expect(TOKEN_TRACKER_ADAPTER_VERSION).toBe(adapterManifest.version);
  });
});
