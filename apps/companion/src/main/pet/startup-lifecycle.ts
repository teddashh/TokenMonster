export class PetStartupStoppedError extends Error {
  public override readonly name = "PetStartupStoppedError"

  public constructor() {
    super("Pet startup stopped")
  }
}

export interface PetStartupLifecycle {
  readonly signal: AbortSignal
  shutdownRequested(): boolean
  assertRunning(): void
  requestShutdown(): void
  currentStartup(): Promise<void> | null
  trackStartup(operation: Promise<void>): void
  trackCredentialWorker<T>(operation: Promise<T>): Promise<T>
  joinCredentialWorkers(): Promise<void>
  join(): Promise<void>
}

/** Tracks retry startup and raw credential work across the pet quit boundary. */
export function createPetStartupLifecycle(): PetStartupLifecycle {
  const controller = new AbortController()
  const credentialWorkers = new Set<Promise<unknown>>()
  let startup: Promise<void> | null = null

  const trackCredentialWorker = <T>(operation: Promise<T>): Promise<T> => {
    credentialWorkers.add(operation)
    void operation.then(
      () => credentialWorkers.delete(operation),
      () => credentialWorkers.delete(operation)
    )
    return operation
  }

  const joinCredentialWorkers = async (): Promise<void> => {
    while (credentialWorkers.size > 0) {
      await Promise.allSettled([...credentialWorkers])
    }
  }

  return Object.freeze({
    signal: controller.signal,
    shutdownRequested: () => controller.signal.aborted,
    assertRunning(): void {
      if (controller.signal.aborted) throw new PetStartupStoppedError()
    },
    requestShutdown(): void {
      controller.abort()
    },
    currentStartup: () => startup,
    trackStartup(operation: Promise<void>): void {
      if (startup !== null) throw new Error("Pet startup already tracked")
      startup = operation
      void operation.then(
        () => {
          if (startup === operation) startup = null
        },
        () => {
          if (startup === operation) startup = null
        }
      )
    },
    trackCredentialWorker,
    joinCredentialWorkers,
    async join(): Promise<void> {
      const activeStartup = startup
      if (activeStartup !== null) await Promise.allSettled([activeStartup])
      await joinCredentialWorkers()
    }
  })
}

/** Closes a service that finishes starting after shutdown instead of adopting it. */
export async function adoptPetStartupOwner<Owner>(
  lifecycle: PetStartupLifecycle,
  owner: Owner,
  adopt: (owner: Owner) => void,
  close: (owner: Owner) => Promise<void>
): Promise<boolean> {
  if (lifecycle.shutdownRequested()) {
    await close(owner)
    return false
  }
  adopt(owner)
  return true
}

/** Treats shutdown cancellation as a clean attempt result, not a fatal boot. */
export async function runPetStartupAttempt(
  lifecycle: PetStartupLifecycle,
  operation: () => Promise<void>,
  onFailure: (error: unknown) => Promise<void>
): Promise<void> {
  try {
    await operation()
  } catch (error: unknown) {
    if (lifecycle.shutdownRequested()) return
    await onFailure(error)
  }
}

/** Aborts startup, closes current owners, joins late work, then closes again. */
export async function drainPetStartupLifecycle(
  lifecycle: PetStartupLifecycle,
  stopActiveOwners: () => Promise<void>
): Promise<void> {
  lifecycle.requestShutdown()
  let failure: unknown = null
  try {
    await stopActiveOwners()
  } catch (error: unknown) {
    failure = error
  }
  try {
    await lifecycle.join()
  } catch (error: unknown) {
    failure ??= error
  }
  try {
    await stopActiveOwners()
  } catch (error: unknown) {
    failure ??= error
  }
  if (failure !== null) throw failure
}

/** Drains a fatally failed attempt without trying to join that attempt itself. */
export async function drainPetStartupAttemptFailure(
  lifecycle: PetStartupLifecycle,
  stopActiveOwners: () => Promise<void>
): Promise<void> {
  lifecycle.requestShutdown()
  let failure: unknown = null
  try {
    await stopActiveOwners()
  } catch (error: unknown) {
    failure = error
  }
  try {
    await lifecycle.joinCredentialWorkers()
  } catch (error: unknown) {
    failure ??= error
  }
  try {
    await stopActiveOwners()
  } catch (error: unknown) {
    failure ??= error
  }
  if (failure !== null) throw failure
}
