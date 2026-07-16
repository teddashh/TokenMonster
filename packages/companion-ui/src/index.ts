import { fileURLToPath } from "node:url";

export const COMPANION_UI_ENTRY_FILE = "index.html" as const;

/**
 * Returns the immutable static asset directory that the loopback gateway may
 * serve. Callers must still apply their own Host, Origin, session, and path
 * traversal policy at the HTTP boundary.
 */
export function getCompanionUiAssetDirectory(): string {
  return fileURLToPath(new URL("./public/", import.meta.url));
}
