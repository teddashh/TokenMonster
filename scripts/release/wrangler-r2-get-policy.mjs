const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const MISSING_LINE = "✘ [ERROR] The specified key does not exist.";
const LOG_LINE_PATTERN = /^🪵\s+Logs were written to "[^"]+"$/u;

export function requireExactWranglerVersionOutput(standardOutput, expected) {
  if (
    typeof standardOutput !== "string" ||
    typeof expected !== "string" ||
    !/^[1-9][0-9]*\.[0-9]+\.[0-9]+$/u.test(expected) ||
    standardOutput.trim() !== expected
  ) {
    throw new Error("Wrangler version output is not the exact audited version");
  }
  return expected;
}

export function classifyWranglerR2Get(exitCode, standardError) {
  if (!Number.isSafeInteger(exitCode) || typeof standardError !== "string") {
    throw new TypeError("Wrangler R2 result is malformed");
  }
  if (exitCode === 0) return "present";
  const lines = standardError
    .replace(ANSI_PATTERN, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (
    exitCode === 1 &&
    lines.filter((line) => line === MISSING_LINE).length === 1 &&
    lines.every((line) => line === MISSING_LINE || LOG_LINE_PATTERN.test(line))
  ) {
    return "missing";
  }
  throw new Error(
    "Wrangler R2 get failed for a reason other than a missing key",
  );
}
