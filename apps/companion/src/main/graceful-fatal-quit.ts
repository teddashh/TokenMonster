import type {
  LegacyBeforeQuitEvent,
  LegacyShutdownCoordinator
} from "./legacy-shutdown.js"

interface FatalQuitApp {
  quit(): void
  exit(exitCode?: number): void
}

interface ReleasableLease {
  release(): Promise<void>
}

export const FATAL_EXIT_CODE = 1

export interface FatalQuitController {
  markLegacyFatalIntent(): void
  requestLegacyFatalQuit(): void
  completeLegacyShutdown(): void
  exitPetFatalAfterDrain(): void
}

export interface PetStartupQuitBridge {
  track(operation: Promise<void>): void
  handleBeforeQuit(event: LegacyBeforeQuitEvent): boolean
}

/** Holds an early pet quit until startPetCompanion installs its own drain. */
export function createPetStartupQuitBridge(
  quit: () => void
): PetStartupQuitBridge {
  let startup: Promise<void> | null = null
  let quitScheduled = false

  return Object.freeze({
    track(operation: Promise<void>): void {
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
    handleBeforeQuit(event: LegacyBeforeQuitEvent): boolean {
      const operation = startup
      if (operation === null) return false
      event.preventDefault()
      if (!quitScheduled) {
        quitScheduled = true
        void operation.then(quit, quit).catch(() => undefined)
      }
      return true
    }
  })
}

/** Records legacy fatal intent; only the post-drain terminal uses app.exit. */
export function createFatalQuitController(
  app: FatalQuitApp
): FatalQuitController {
  let fatalExitCode: number | null = null
  const markLegacyFatalIntent = (): void => {
    fatalExitCode = FATAL_EXIT_CODE
  }
  return Object.freeze({
    markLegacyFatalIntent,
    requestLegacyFatalQuit(): void {
      markLegacyFatalIntent()
      app.quit()
    },
    completeLegacyShutdown(): void {
      if (fatalExitCode === null) app.quit()
      else app.exit(fatalExitCode)
    },
    exitPetFatalAfterDrain(): void {
      app.exit(FATAL_EXIT_CODE)
    }
  })
}

/** Drains the pet startup lease before its caller performs a terminal exit. */
export async function runPetStartupWithOwnedLease<
  Lease extends ReleasableLease
>(lease: Lease, start: (lease: Lease) => Promise<void>): Promise<void> {
  try {
    await start(lease)
  } catch (error: unknown) {
    await lease.release().catch(() => undefined)
    throw error
  }
}

export function handleModeAwareBeforeQuit(
  petMode: boolean,
  coordinator: LegacyShutdownCoordinator,
  event: LegacyBeforeQuitEvent
): void {
  if (!petMode) coordinator.handleBeforeQuit(event)
}
