import type { UsageDomainState } from "./types.js";

export function createUsageDomainState(): UsageDomainState {
  return {
    version: 0,
    rows: new Map(),
    authorityBindings: new Map(),
    batchReceipts: new Map(),
    anonymousRollups: new Map()
  };
}
