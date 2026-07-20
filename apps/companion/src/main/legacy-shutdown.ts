export interface LegacyBeforeQuitEvent {
  preventDefault(): void
}

interface DisposableService {
  dispose(): void
}

interface QuiescentContributionService extends DisposableService {
  quiesce(): Promise<void>
}

interface ClosableStore {
  close(): void
}

export interface LegacyOwnedServices {
  readonly scheduler: DisposableService | null
  readonly detachScheduler: (() => void) | null
  readonly byok: DisposableService | null
  readonly contribution: QuiescentContributionService | null
  readonly collector: DisposableService | null
  readonly store: ClosableStore | null
}

export interface LegacyShutdownCoordinator {
  handleBeforeQuit(event: LegacyBeforeQuitEvent): void
  completion(): Promise<void> | null
}

interface LegacyShutdownCoordinatorOptions {
  readonly closeOwnedServices: () => Promise<void>
  readonly releaseLease: () => Promise<void>
  readonly quit: () => void
}

function bestEffort(operation: (() => void) | null): void {
  try {
    operation?.()
  } catch {
    // Shutdown diagnostics remain content-free and later owners still close.
  }
}

/** Keeps the LocalStore alive until contribution requests have fully drained. */
export async function closeLegacyOwnedServices(
  services: LegacyOwnedServices
): Promise<void> {
  bestEffort(services.detachScheduler)
  bestEffort(
    services.scheduler === null ? null : () => services.scheduler?.dispose()
  )
  bestEffort(services.byok === null ? null : () => services.byok?.dispose())
  bestEffort(
    services.contribution === null
      ? null
      : () => services.contribution?.dispose()
  )
  bestEffort(
    services.collector === null ? null : () => services.collector?.dispose()
  )
  try {
    await services.contribution?.quiesce()
  } catch {
    // A failed drain cannot skip the remaining local shutdown owners.
  }
  bestEffort(services.store === null ? null : () => services.store?.close())
}

/** Defers Electron quit exactly once until legacy-owned state is quiescent. */
export function createLegacyShutdownCoordinator(
  options: LegacyShutdownCoordinatorOptions
): LegacyShutdownCoordinator {
  let quitAllowed = false
  let shutdown: Promise<void> | null = null

  const handleBeforeQuit = (event: LegacyBeforeQuitEvent): void => {
    if (quitAllowed) return
    event.preventDefault()
    if (shutdown !== null) return
    shutdown = (async () => {
      try {
        await options.closeOwnedServices()
      } catch {
        // Lease release is the final ownership boundary even on close failure.
      }
      try {
        await options.releaseLease()
      } catch {
        // The legacy shell must not loop forever on an unavailable lease file.
      }
      quitAllowed = true
      options.quit()
    })()
  }

  return Object.freeze({
    handleBeforeQuit,
    completion: () => shutdown
  })
}
