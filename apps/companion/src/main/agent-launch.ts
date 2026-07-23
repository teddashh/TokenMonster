export const AGENT_LAUNCH_READY_MARKER =
  "[TOKENMONSTER_AGENT] READY companion\n"

export const AGENT_LAUNCH_READY_PIPE_ID_ENV = "TOKENMONSTER_AGENT_READY_PIPE_ID"
export const AGENT_LAUNCH_READY_CAPABILITY_ENV =
  "TOKENMONSTER_AGENT_READY_CAPABILITY"

export const AGENT_LAUNCH_PHASES = Object.freeze([
  "state",
  "window",
  "initialized",
  "shell",
  "credentials",
  "services",
  "bootstrap",
  "view",
  "ready-shell"
] as const)
export type AgentLaunchPhase = (typeof AGENT_LAUNCH_PHASES)[number]

const WINDOWS_READY_PIPE_ID_PATTERN = /^[0-9a-f]{32}$/u
const WINDOWS_READY_CAPABILITY_PATTERN = /^[0-9a-f]{64}$/u
const WINDOWS_READY_PIPE_PREFIX = "\\\\.\\pipe\\tokenmonster-agent-ready-"

export interface AgentLaunchWindowsChannel {
  write(marker: string): Promise<boolean>
  end(marker: string): Promise<boolean>
  destroy(): void
}

export interface AgentLaunchReadyReporter {
  reportConnected(): Promise<boolean>
  reportPhase(phase: AgentLaunchPhase): Promise<boolean>
  reportReady(): Promise<boolean>
}

export interface AgentLaunchReadyReporterOptions {
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly argv: readonly string[]
  readonly packaged: boolean
  readonly platform: NodeJS.Platform
  readonly processId: number
  readonly openWindowsPipe: (
    path: string
  ) => Promise<AgentLaunchWindowsChannel | null>
  readonly write: (marker: string) => void
}

export interface AgentParentDisconnectGuardOptions {
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly argv: readonly string[]
  readonly packaged: boolean
  readonly connected: boolean
  readonly onDisconnect: (listener: () => void) => void
  readonly exit: (code: number) => void
}

function sourceAgentLaunchEnabled(
  environment: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  packaged: boolean
): boolean {
  return (
    !packaged &&
    environment["TOKENMONSTER_AGENT_LAUNCH"] === "1" &&
    argv.includes("--tokenmonster-agent-launch")
  )
}

/**
 * Source-launch readiness is deliberately opt-in and content-blind. Packaged
 * builds never participate, even if both development gates are supplied.
 */
export function createAgentLaunchReadyReporter(
  options: AgentLaunchReadyReporterOptions
): AgentLaunchReadyReporter {
  const enabled = sourceAgentLaunchEnabled(
    options.environment,
    options.argv,
    options.packaged
  )
  const windowsPipeId = options.environment[AGENT_LAUNCH_READY_PIPE_ID_ENV]
  const windowsCapability =
    options.environment[AGENT_LAUNCH_READY_CAPABILITY_ENV]
  const windowsChannelValid =
    typeof windowsPipeId === "string" &&
    WINDOWS_READY_PIPE_ID_PATTERN.test(windowsPipeId) &&
    typeof windowsCapability === "string" &&
    WINDOWS_READY_CAPABILITY_PATTERN.test(windowsCapability) &&
    Number.isSafeInteger(options.processId) &&
    options.processId > 0 &&
    options.processId <= 2_147_483_647
  let channel: AgentLaunchWindowsChannel | null = null
  let connectAttempted = false
  let connected = false
  let nextPhaseIndex = 0
  let phaseInFlight = false
  let readyAttempted = false

  const destroyWindowsChannel = (): void => {
    try {
      channel?.destroy()
    } catch {
      // A broken transport is already a failed readiness report.
    } finally {
      channel = null
    }
  }

  return Object.freeze({
    async reportConnected(): Promise<boolean> {
      if (!enabled || connected || connectAttempted) return false
      connectAttempted = true
      if (options.platform !== "win32") {
        connected = true
        return true
      }
      if (
        !windowsChannelValid ||
        windowsPipeId === undefined ||
        windowsCapability === undefined
      ) {
        return false
      }
      try {
        channel = await options.openWindowsPipe(
          `${WINDOWS_READY_PIPE_PREFIX}${windowsPipeId}`
        )
      } catch {
        return false
      }
      if (channel === null) return false
      const hello =
        `[TOKENMONSTER_AGENT_PRIVATE] HELLO companion ` +
        `pid=${options.processId} cap=${windowsCapability}\n`
      try {
        if (await channel.write(hello)) {
          connected = true
          return true
        }
      } catch {
        // The private readiness channel is diagnostic only. Fail closed
        // without taking down the local companion.
      }
      destroyWindowsChannel()
      return false
    },
    async reportPhase(phase: AgentLaunchPhase): Promise<boolean> {
      if (
        !enabled ||
        !connected ||
        readyAttempted ||
        phaseInFlight ||
        AGENT_LAUNCH_PHASES[nextPhaseIndex] !== phase
      ) {
        return false
      }
      phaseInFlight = true
      try {
        if (options.platform === "win32") {
          if (channel === null) return false
          let sent = false
          try {
            sent = await channel.write(
              `[TOKENMONSTER_AGENT_PRIVATE] PHASE ${phase}\n`
            )
          } catch {
            sent = false
          }
          if (!sent) {
            destroyWindowsChannel()
            return false
          }
        }
        nextPhaseIndex += 1
        return true
      } finally {
        phaseInFlight = false
      }
    },
    async reportReady(): Promise<boolean> {
      if (!enabled || readyAttempted) return false
      readyAttempted = true
      if (nextPhaseIndex !== AGENT_LAUNCH_PHASES.length) {
        if (options.platform === "win32") destroyWindowsChannel()
        return false
      }
      if (options.platform !== "win32") {
        if (!connected) return false
        try {
          options.write(AGENT_LAUNCH_READY_MARKER)
          return true
        } catch {
          return false
        }
      }
      if (!connected || channel === null) return false
      let sent = false
      try {
        sent = await channel.end(AGENT_LAUNCH_READY_MARKER)
      } catch {
        sent = false
      }
      if (!sent) {
        destroyWindowsChannel()
      } else {
        channel = null
      }
      return sent
    }
  })
}

export function installAgentParentDisconnectGuard(
  options: AgentParentDisconnectGuardOptions
): boolean {
  if (
    !sourceAgentLaunchEnabled(
      options.environment,
      options.argv,
      options.packaged
    )
  ) {
    return false
  }
  if (!options.connected) {
    options.exit(1)
    return true
  }
  options.onDisconnect(() => {
    options.exit(1)
  })
  return true
}
