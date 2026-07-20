const SIDECAR_EGRESS_BLOCKED_MESSAGE =
  "TokenMonster blocked sidecar network egress.";

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(keys)
  );
}

export function requireDisabledRemoteLimitsResponse({
  body,
  platform,
  status,
}) {
  if (
    platform === "darwin" &&
    status === 500 &&
    hasExactKeys(body, ["error"]) &&
    body.error === SIDECAR_EGRESS_BLOCKED_MESSAGE
  ) {
    return "macos-native-helper-blocked";
  }
  if (platform !== "darwin" && status === 200) return "neutral-response";
  throw new Error(
    `upstream remote-limits drill returned unexpected HTTP ${status}`,
  );
}
