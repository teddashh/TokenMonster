import { expect } from "vitest";

// Node on Windows does not report POSIX modes (0666 for files, 0777 for
// directories), so this assertion runs only on macOS and Linux. Windows
// relies on the permissions of the folder the file lives in.
export function expectUnixMode(
  actualMode: number,
  expectedMode: number
): void {
  if (process.platform === "win32") return;
  expect(actualMode & 0o777).toBe(expectedMode);
}
