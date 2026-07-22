import { join } from "node:path";

import { createMemorySecretSlot } from "@tokenmonster/secret-vault";
import { TokenTrackerRuntimeError } from "@tokenmonster/token-tracker-runtime";
import { describe, expect, it } from "vitest";

import {
  PET_CHARACTER_CDN_BASE_URL,
  PetStartupError,
  createPetCharacterOptions,
  createPetGatewayOptions
} from "../src/main/pet/services.js";

describe("pet character transport privacy", () => {
  it("retains only a bounded sidecar startup diagnostic", () => {
    expect(
      new PetStartupError("sidecar", {
        cause: new TokenTrackerRuntimeError("version-mismatch")
      }).sidecarCode
    ).toBe("version-mismatch");
    expect(
      new PetStartupError("sidecar", { cause: new Error("private detail") })
        .sidecarCode
    ).toBe("unknown");
    expect(new PetStartupError("gateway").sidecarCode).toBeNull();
  });

  it("keeps the retired Electron entry point cache-only", () => {
    expect(PET_CHARACTER_CDN_BASE_URL).toBeNull();
    expect(createPetCharacterOptions("/home/tester")).toMatchObject({
      manifest: null,
      assetPack: null,
      cacheDirectory: join("/home/tester", ".tokenmonster", "asset-cache"),
      cdnBaseUrl: null,
      progressionStorePath: join(
        "/home/tester",
        ".tokenmonster",
        "progression-v1.json"
      )
    });
  });

  it("passes the caller-owned BYOK authority through without inspecting it", async () => {
    const byok = createMemorySecretSlot();
    const options = createPetGatewayOptions(
      {} as never,
      {} as never,
      byok,
      "/home/tester",
      "/package/companion-ui/dist/public"
    );
    expect(options.byok).toBe(byok);
    expect(
      createPetGatewayOptions(
        {} as never,
        {} as never,
        null,
        "/home/tester",
        "/package/companion-ui/dist/public"
      ).byok
    ).toBeNull();

    const keyCanary = ["sk", "pet_memory_1234567890abcdef_CANARY"].join("-");
    await byok.set(keyCanary, { persist: true });
    expect(byok.status()).toMatchObject({ persistence: "memory-only" });
    expect(JSON.stringify(byok.status())).not.toContain(keyCanary);
  });
});
