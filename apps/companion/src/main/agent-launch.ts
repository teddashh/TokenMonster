export const AGENT_LAUNCH_READY_MARKER =
  "[TOKENMONSTER_AGENT] READY companion\n"

export interface AgentLaunchReadyMessage {
  readonly schemaVersion: 1
  readonly type: "tokenmonster_agent_ready"
}

export const AGENT_LAUNCH_READY_MESSAGE: AgentLaunchReadyMessage =
  Object.freeze({
    schemaVersion: 1,
    type: "tokenmonster_agent_ready"
  })

export interface AgentLaunchReadyReporter {
  reportReady(): boolean
}

export interface AgentLaunchReadyReporterOptions {
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly argv: readonly string[]
  readonly packaged: boolean
  readonly platform: NodeJS.Platform
  readonly send: (message: AgentLaunchReadyMessage) => boolean
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
  let reported = false

  return Object.freeze({
    reportReady(): boolean {
      if (!enabled || reported) return false
      if (
        options.platform === "win32" &&
        !options.send(AGENT_LAUNCH_READY_MESSAGE)
      ) {
        return false
      }
      reported = true
      if (options.platform !== "win32") {
        options.write(AGENT_LAUNCH_READY_MARKER)
      }
      return true
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
