export interface LegacyBeforeQuitEvent {
  preventDefault(): void
}

interface DisposableService {
  dispose(): void
}

interface QuiescentContributionService extends DisposableService {
  quiesce(): Promise<void>
}

interface QuiescentByokService extends DisposableService {
  quiesce(): Promise<void>
}

interface QuiescentCollectorService extends DisposableService {
  quiesce(): Promise<void>
}

interface ClosableStore {
  close(): void
}

export interface LegacyOwnedServices {
  readonly scheduler: DisposableService | null
  readonly detachScheduler: (() => void) | null
  readonly byok: QuiescentByokService | null
  readonly contribution: QuiescentContributionService | null
  readonly collector: QuiescentCollectorService | null
  readonly store: ClosableStore | null
}

export interface LegacyShutdownCoordinator {
  handleBeforeQuit(event: LegacyBeforeQuitEvent): void
  completion(): Promise<void> | null
}

export class LegacyStartupStoppedError extends Error {
  public override readonly name = "LegacyStartupStoppedError"

  public constructor() {
    super("Legacy startup stopped")
  }
}

export interface LegacyStartupFence {
  track(operation: Promise<void>): void
  assertRunning(): void
  shutdownRequested(): boolean
  requestShutdown(): void
  join(): Promise<void>
}

/** Fences late startup continuations and joins them before owner capture. */
export function createLegacyStartupFence(): LegacyStartupFence {
  let operation: Promise<void> | null = null
  let stopping = false

  return Object.freeze({
    track(nextOperation: Promise<void>): void {
      if (operation !== null) {
        throw new Error("Legacy startup already tracked")
      }
      operation = nextOperation
    },
    assertRunning(): void {
      if (stopping) throw new LegacyStartupStoppedError()
    },
    shutdownRequested: () => stopping,
    requestShutdown(): void {
      stopping = true
    },
    async join(): Promise<void> {
      try {
        await operation
      } catch {
        // The startup observer owns fatal reporting; shutdown owns cleanup.
      }
    }
  })
}

export async function startLegacyRuntimeWithOwnedLease<Lease>(
  lease: Lease,
  retainLease: (lease: Lease) => void,
  start: () => Promise<void>
): Promise<void> {
  retainLease(lease)
  await start()
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

/** Synchronously aborts every owner that can unblock an in-progress startup. */
export function disposeLegacyOwnedServices(
  services: LegacyOwnedServices
): void {
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
}

/** Keeps local ownership until BYOK and contribution work have fully drained. */
export async function closeLegacyOwnedServices(
  services: LegacyOwnedServices
): Promise<void> {
  disposeLegacyOwnedServices(services)
  try {
    await services.byok?.quiesce()
  } catch {
    // Credential cleanup failure cannot skip later local shutdown owners.
  }
  try {
    await services.contribution?.quiesce()
  } catch {
    // A failed drain cannot skip the remaining local shutdown owners.
  }
  try {
    await services.collector?.quiesce()
  } catch {
    // A failed collector drain cannot skip the local store close.
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
