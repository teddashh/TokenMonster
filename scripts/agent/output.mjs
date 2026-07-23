import { commandPayload } from "./contract.mjs";

export function emit(command, payload, { json = false } = {}) {
  const value = commandPayload(command, payload);
  process.stdout.write(
    `${JSON.stringify(value, null, json ? undefined : 2)}\n`,
  );
}

export function emitUsage(command, { json = false } = {}) {
  emit(command, { ok: false, state: "usage_error" }, { json });
  return 2;
}

export function platformName(platform = process.platform) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "unsupported";
}
