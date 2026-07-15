import type {
  ByokRuntimeStatus,
  CompanionBootstrap,
} from "../../shared/ipc.js";

type ByokBearingState = Pick<CompanionBootstrap, "byok" | "mode">;

export function mergeByokStatus<T extends ByokBearingState>(
  state: T,
  byok: ByokRuntimeStatus,
): Omit<T, keyof ByokBearingState> & ByokBearingState {
  return Object.freeze({
    ...state,
    byok,
    mode: byok.configured ? "byok-direct" : "local-only",
  });
}

export async function settleCredentialRefresh(
  refresh: () => Promise<void>,
): Promise<boolean> {
  try {
    await refresh();
    return true;
  } catch {
    return false;
  }
}
