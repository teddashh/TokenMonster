import { describe, expect, it, vi } from "vitest";

import type { ByokRuntimeStatus } from "../src/shared/ipc.js";
import {
  mergeByokStatus,
  settleCredentialRefresh,
} from "../src/renderer/src/credential-mutation.js";

const CONFIGURED: ByokRuntimeStatus = Object.freeze({
  configured: true,
  persistence: "os-backed",
  canPersist: true,
  backend: "keychain",
  provider: "OpenAI",
  model: "gpt-5.6-luna",
});

describe("credential mutation renderer state", () => {
  it("keeps a successful credential mutation locally when refresh rejects", async () => {
    const state = mergeByokStatus(
      {
        mode: "local-only" as const,
        byok: {
          ...CONFIGURED,
          configured: false,
          persistence: "memory-only" as const,
        },
        marker: "preserved",
      },
      CONFIGURED,
    );
    const refresh = vi.fn().mockRejectedValue(new Error("refresh failed"));

    await expect(settleCredentialRefresh(refresh)).resolves.toBe(false);
    expect(state).toMatchObject({
      marker: "preserved",
      mode: "byok-direct",
      byok: CONFIGURED,
    });
  });

  it("reports a completed refresh without mutating the credential result", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    await expect(settleCredentialRefresh(refresh)).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
