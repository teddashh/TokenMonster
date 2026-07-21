import { describe, expect, it } from "vitest";

import {
  CONTRIBUTION_FIELD_ALLOWLIST as packagedAllowlist,
  createContributionService as packagedFactory,
} from "@tokenmonster/contribution-runtime";

import {
  CONTRIBUTION_FIELD_ALLOWLIST,
  createContributionService,
} from "../src/main/contribution-service.js";

describe("legacy Electron contribution composition", () => {
  it("uses the shared contribution runtime as its only product authority", () => {
    expect(createContributionService).toBe(packagedFactory);
    expect(CONTRIBUTION_FIELD_ALLOWLIST).toBe(packagedAllowlist);
  });
});
