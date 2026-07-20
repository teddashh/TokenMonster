import { describe, expect, it } from "vitest";

import {
  QUOTA_FAMILIES,
  QUOTA_PLAN_OPTIONS
} from "../../companion-ui/src/public/dto.js";
import {
  QUOTA_CATALOG_FAMILIES,
  QUOTA_PLAN_CATALOG
} from "../src/quota-catalog.js";

describe("quota catalog drift guard", () => {
  it("keeps UI family and plan IDs aligned with the gateway catalog", () => {
    expect(QUOTA_FAMILIES).toEqual(QUOTA_CATALOG_FAMILIES);

    const gatewayPlans = QUOTA_CATALOG_FAMILIES.map((family) => [
      family,
      QUOTA_PLAN_CATALOG.filter((plan) => plan.family === family).map(
        ({ planId, labelZh }) => ({ planId, labelZh })
      )
    ]);
    const uiPlans = QUOTA_FAMILIES.map((family) => [
      family,
      QUOTA_PLAN_OPTIONS[family].map(({ planId, labelZh }) => ({
        planId,
        labelZh
      }))
    ]);

    expect(uiPlans).toEqual(gatewayPlans);
  });
});
