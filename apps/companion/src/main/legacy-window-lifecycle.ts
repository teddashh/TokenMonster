interface SuspendableByokService {
  suspend(): void
}

/** Window teardown is temporary on macOS and must not dispose BYOK state. */
export function suspendLegacyWindowByok(
  service: SuspendableByokService | null
): void {
  try {
    service?.suspend()
  } catch {
    // A window close still completes if request cancellation throws.
  }
}

export function closeLegacyAppWhenWindowless(
  platform: NodeJS.Platform,
  quit: () => void
): void {
  if (platform !== "darwin") quit()
}
