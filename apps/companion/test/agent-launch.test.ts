import { readFile } from "node:fs/promises"

import { describe, expect, it, vi } from "vitest"

import {
  AGENT_LAUNCH_READY_CAPABILITY_ENV,
  AGENT_LAUNCH_READY_MARKER,
  AGENT_LAUNCH_READY_PIPE_ID_ENV,
  createAgentLaunchReadyReporter,
  installAgentParentDisconnectGuard,
  type AgentLaunchWindowsChannel
} from "../src/main/agent-launch.js"

const WINDOWS_PIPE_ID = "a".repeat(32)
const WINDOWS_CAPABILITY = "b".repeat(64)
const WINDOWS_PIPE_PATH =
  "\\\\.\\pipe\\tokenmonster-agent-ready-" + WINDOWS_PIPE_ID
const WINDOWS_PROCESS_ID = 4_242

function reporter(
  environment: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  options: Readonly<{
    packaged?: boolean
    platform?: NodeJS.Platform
    processId?: number
  }> = {}
) {
  const channelWrite = vi.fn(async (_marker: string): Promise<boolean> => true)
  const channelEnd = vi.fn(async (_marker: string): Promise<boolean> => true)
  const channelDestroy = vi.fn<() => void>()
  const channel: AgentLaunchWindowsChannel = Object.freeze({
    write: channelWrite,
    end: channelEnd,
    destroy: channelDestroy
  })
  const openWindowsPipe = vi.fn(
    async (_path: string): Promise<AgentLaunchWindowsChannel | null> => channel
  )
  const write = vi.fn<(marker: string) => void>()
  const ready = createAgentLaunchReadyReporter({
    environment,
    argv,
    packaged: options.packaged ?? false,
    platform: options.platform ?? "linux",
    processId: options.processId ?? WINDOWS_PROCESS_ID,
    openWindowsPipe,
    write
  })
  return Object.freeze({
    ready,
    channelWrite,
    channelEnd,
    channelDestroy,
    openWindowsPipe,
    write
  })
}

function windowsEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {}
): Readonly<Record<string, string | undefined>> {
  return {
    TOKENMONSTER_AGENT_LAUNCH: "1",
    [AGENT_LAUNCH_READY_PIPE_ID_ENV]: WINDOWS_PIPE_ID,
    [AGENT_LAUNCH_READY_CAPABILITY_ENV]: WINDOWS_CAPABILITY,
    ...overrides
  }
}

describe("agent source-launch readiness contract", () => {
  it("exits on parent disconnect only for a connected dual-gated source run", () => {
    const listeners: Array<() => void> = []
    const exit = vi.fn<(code: number) => void>()
    const installed = installAgentParentDisconnectGuard({
      environment: { TOKENMONSTER_AGENT_LAUNCH: "1" },
      argv: ["--tokenmonster-agent-launch"],
      packaged: false,
      connected: true,
      onDisconnect: (listener) => listeners.push(listener),
      exit
    })

    expect(installed).toBe(true)
    expect(listeners).toHaveLength(1)
    listeners[0]?.()
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it("exits immediately when a dual-gated source child starts disconnected", () => {
    const onDisconnect = vi.fn<(listener: () => void) => void>()
    const exit = vi.fn<(code: number) => void>()
    expect(
      installAgentParentDisconnectGuard({
        environment: { TOKENMONSTER_AGENT_LAUNCH: "1" },
        argv: ["--tokenmonster-agent-launch"],
        packaged: false,
        connected: false,
        onDisconnect,
        exit
      })
    ).toBe(true)
    expect(onDisconnect).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it.each([
    {
      name: "single gated",
      environment: { TOKENMONSTER_AGENT_LAUNCH: "1" },
      argv: [] as readonly string[],
      packaged: false,
      connected: true
    },
    {
      name: "packaged",
      environment: { TOKENMONSTER_AGENT_LAUNCH: "1" },
      argv: ["--tokenmonster-agent-launch"] as readonly string[],
      packaged: true,
      connected: true
    }
  ])("does not install a parent guard when $name", (options) => {
    const onDisconnect = vi.fn<(listener: () => void) => void>()
    const exit = vi.fn<(code: number) => void>()
    expect(
      installAgentParentDisconnectGuard({
        ...options,
        onDisconnect,
        exit
      })
    ).toBe(false)
    expect(onDisconnect).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: "environment-only",
      environment: { TOKENMONSTER_AGENT_LAUNCH: "1" },
      argv: [] as readonly string[]
    },
    {
      name: "argument-only",
      environment: {},
      argv: ["--tokenmonster-agent-launch"] as readonly string[]
    }
  ])(
    "does not connect or report for $name activation",
    async ({ environment, argv }) => {
      const harness = reporter(environment, argv)

      await expect(harness.ready.reportConnected()).resolves.toBe(false)
      await expect(harness.ready.reportReady()).resolves.toBe(false)
      expect(harness.openWindowsPipe).not.toHaveBeenCalled()
      expect(harness.write).not.toHaveBeenCalled()
    }
  )

  it("reports the exact fixed marker on POSIX after source connection", async () => {
    const harness = reporter({ TOKENMONSTER_AGENT_LAUNCH: "1" }, [
      "electron",
      ".",
      "--tokenmonster-agent-launch"
    ])

    await expect(harness.ready.reportConnected()).resolves.toBe(true)
    await expect(harness.ready.reportReady()).resolves.toBe(true)
    expect(harness.write).toHaveBeenCalledOnce()
    expect(harness.write).toHaveBeenCalledWith(
      "[TOKENMONSTER_AGENT] READY companion\n"
    )
    expect(AGENT_LAUNCH_READY_MARKER).toBe(
      "[TOKENMONSTER_AGENT] READY companion\n"
    )
    expect(harness.openWindowsPipe).not.toHaveBeenCalled()
  })

  it("fails closed when POSIX readiness is attempted before connection", async () => {
    const harness = reporter({ TOKENMONSTER_AGENT_LAUNCH: "1" }, [
      "--tokenmonster-agent-launch"
    ])

    await expect(harness.ready.reportReady()).resolves.toBe(false)
    await expect(harness.ready.reportConnected()).resolves.toBe(true)
    await expect(harness.ready.reportReady()).resolves.toBe(false)
    expect(harness.write).not.toHaveBeenCalled()
  })

  it("uses one authenticated Windows pipe for HELLO then READY", async () => {
    const harness = reporter(
      windowsEnvironment(),
      ["electron", ".", "--tokenmonster-agent-launch"],
      { platform: "win32" }
    )

    await expect(harness.ready.reportConnected()).resolves.toBe(true)
    expect(harness.openWindowsPipe).toHaveBeenCalledOnce()
    expect(harness.openWindowsPipe).toHaveBeenCalledWith(WINDOWS_PIPE_PATH)
    expect(harness.channelWrite).toHaveBeenCalledOnce()
    expect(harness.channelWrite).toHaveBeenCalledWith(
      `[TOKENMONSTER_AGENT_PRIVATE] HELLO companion ` +
        `pid=${WINDOWS_PROCESS_ID} cap=${WINDOWS_CAPABILITY}\n`
    )

    await expect(harness.ready.reportReady()).resolves.toBe(true)
    expect(harness.channelEnd).toHaveBeenCalledOnce()
    expect(harness.channelEnd).toHaveBeenCalledWith(
      "[TOKENMONSTER_AGENT] READY companion\n"
    )
    expect(harness.channelDestroy).not.toHaveBeenCalled()
    expect(harness.write).not.toHaveBeenCalled()
  })

  it("opens the Windows pipe at most once under concurrent calls", async () => {
    const harness = reporter(
      windowsEnvironment(),
      ["--tokenmonster-agent-launch"],
      { platform: "win32" }
    )

    await expect(
      Promise.all([
        harness.ready.reportConnected(),
        harness.ready.reportConnected(),
        harness.ready.reportConnected()
      ])
    ).resolves.toEqual([true, false, false])
    expect(harness.openWindowsPipe).toHaveBeenCalledOnce()
    expect(harness.channelWrite).toHaveBeenCalledOnce()
  })

  it("fails closed when the Windows readiness pipe is unavailable", async () => {
    const harness = reporter(
      windowsEnvironment(),
      ["--tokenmonster-agent-launch"],
      { platform: "win32" }
    )
    harness.openWindowsPipe.mockResolvedValue(null)

    await expect(harness.ready.reportConnected()).resolves.toBe(false)
    await expect(harness.ready.reportConnected()).resolves.toBe(false)
    await expect(harness.ready.reportReady()).resolves.toBe(false)
    expect(harness.openWindowsPipe).toHaveBeenCalledOnce()
    expect(harness.channelWrite).not.toHaveBeenCalled()
    expect(harness.channelEnd).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: "missing pipe id",
      environment: windowsEnvironment({
        [AGENT_LAUNCH_READY_PIPE_ID_ENV]: undefined
      }),
      processId: WINDOWS_PROCESS_ID
    },
    {
      name: "uppercase pipe id",
      environment: windowsEnvironment({
        [AGENT_LAUNCH_READY_PIPE_ID_ENV]: "A".repeat(32)
      }),
      processId: WINDOWS_PROCESS_ID
    },
    {
      name: "short capability",
      environment: windowsEnvironment({
        [AGENT_LAUNCH_READY_CAPABILITY_ENV]: "b".repeat(63)
      }),
      processId: WINDOWS_PROCESS_ID
    },
    {
      name: "zero process id",
      environment: windowsEnvironment(),
      processId: 0
    },
    {
      name: "oversized process id",
      environment: windowsEnvironment(),
      processId: 2_147_483_648
    }
  ])(
    "rejects an invalid Windows channel contract: $name",
    async ({ environment, processId }) => {
      const harness = reporter(environment, ["--tokenmonster-agent-launch"], {
        platform: "win32",
        processId
      })

      await expect(harness.ready.reportConnected()).resolves.toBe(false)
      await expect(harness.ready.reportReady()).resolves.toBe(false)
      expect(harness.openWindowsPipe).not.toHaveBeenCalled()
      expect(harness.channelWrite).not.toHaveBeenCalled()
      expect(harness.channelEnd).not.toHaveBeenCalled()
    }
  )

  it("destroys a Windows channel when HELLO cannot be written", async () => {
    const harness = reporter(
      windowsEnvironment(),
      ["--tokenmonster-agent-launch"],
      { platform: "win32" }
    )
    harness.channelWrite.mockResolvedValue(false)

    await expect(harness.ready.reportConnected()).resolves.toBe(false)
    await expect(harness.ready.reportReady()).resolves.toBe(false)
    expect(harness.channelDestroy).toHaveBeenCalledOnce()
    expect(harness.channelEnd).not.toHaveBeenCalled()
  })

  it("destroys a Windows channel when READY cannot be ended", async () => {
    const harness = reporter(
      windowsEnvironment(),
      ["--tokenmonster-agent-launch"],
      { platform: "win32" }
    )
    harness.channelEnd.mockResolvedValue(false)

    await expect(harness.ready.reportConnected()).resolves.toBe(true)
    await expect(harness.ready.reportReady()).resolves.toBe(false)
    expect(harness.channelDestroy).toHaveBeenCalledOnce()
  })

  it("does not open a readiness channel from a packaged app", async () => {
    const harness = reporter(
      windowsEnvironment(),
      ["--tokenmonster-agent-launch"],
      { packaged: true, platform: "win32" }
    )

    await expect(harness.ready.reportConnected()).resolves.toBe(false)
    await expect(harness.ready.reportReady()).resolves.toBe(false)
    expect(harness.openWindowsPipe).not.toHaveBeenCalled()
    expect(harness.channelWrite).not.toHaveBeenCalled()
    expect(harness.channelEnd).not.toHaveBeenCalled()
  })

  it("reports readiness at most once in the same POSIX run", async () => {
    const harness = reporter({ TOKENMONSTER_AGENT_LAUNCH: "1" }, [
      "--tokenmonster-agent-launch"
    ])

    await expect(harness.ready.reportConnected()).resolves.toBe(true)
    await expect(harness.ready.reportConnected()).resolves.toBe(false)
    await expect(harness.ready.reportReady()).resolves.toBe(true)
    await expect(harness.ready.reportReady()).resolves.toBe(false)
    expect(harness.write).toHaveBeenCalledOnce()
  })

  it("installs the parent guard before Electron startup work", async () => {
    const source = await readFile(
      new URL("../src/main/main.ts", import.meta.url),
      "utf8"
    )
    const runStart = source.indexOf("function run(): void")
    const guard = source.indexOf(
      "installAgentParentDisconnectGuard({",
      runStart
    )
    const squirrel = source.indexOf("handleDefaultSquirrelStartup", guard)
    const ready = source.indexOf("app.whenReady()", guard)

    expect([runStart, guard, squirrel, ready]).not.toContain(-1)
    expect(runStart).toBeLessThan(guard)
    expect(guard).toBeLessThan(squirrel)
    expect(guard).toBeLessThan(ready)
  })

  it("drains Electron on parent loss with one bounded hard-exit fallback", async () => {
    const source = await readFile(
      new URL("../src/main/main.ts", import.meta.url),
      "utf8"
    )

    expect(source.match(/process\.exitCode = code/gu)).toHaveLength(1)
    expect(source).toMatch(
      /exit: \(code\) => \{\s+process\.exitCode = code\s+const hardExit = setTimeout\(\(\) => app\.exit\(code\), 15_000\)\s+hardExit\.unref\(\)\s+app\.quit\(\)\s+\}/u
    )
  })

  it("connects before startup and removes private channel values from the app environment", async () => {
    const source = await readFile(
      new URL("../src/main/pet/pet.ts", import.meta.url),
      "utf8"
    )
    const reporterCreated = source.indexOf(
      "const agentLaunchReady = createAgentLaunchReadyReporter({"
    )
    const pipeIdDeleted = source.indexOf(
      "delete process.env[AGENT_LAUNCH_READY_PIPE_ID_ENV]",
      reporterCreated
    )
    const capabilityDeleted = source.indexOf(
      "delete process.env[AGENT_LAUNCH_READY_CAPABILITY_ENV]",
      pipeIdDeleted
    )
    const connected = source.indexOf(
      "await agentLaunchReady.reportConnected()",
      capabilityDeleted
    )
    const sessionGuards = source.indexOf("installSessionGuards(", connected)
    const serviceStartup = source.indexOf(
      "await startPetServices(petByokSecretSlot)",
      sessionGuards
    )

    expect([
      reporterCreated,
      pipeIdDeleted,
      capabilityDeleted,
      connected,
      sessionGuards,
      serviceStartup
    ]).not.toContain(-1)
    expect(reporterCreated).toBeLessThan(pipeIdDeleted)
    expect(pipeIdDeleted).toBeLessThan(capabilityDeleted)
    expect(capabilityDeleted).toBeLessThan(connected)
    expect(connected).toBeLessThan(sessionGuards)
    expect(sessionGuards).toBeLessThan(serviceStartup)
    expect(
      source.match(/agentLaunchReady\.reportConnected\(\)/gu)
    ).toHaveLength(1)
    expect(source).not.toContain("agentLaunchReady.reportPhase(")
  })

  it("reports only after services, authenticated pet view, and shell are ready", async () => {
    const source = await readFile(
      new URL("../src/main/pet/pet.ts", import.meta.url),
      "utf8"
    )
    expect(source).toContain("environment: process.env")
    expect(source).toContain("argv: process.argv")
    expect(source).toContain("packaged: app.isPackaged")
    expect(source).toContain("platform: process.platform")
    expect(source).toContain("processId: process.pid")
    expect(source).toContain("openWindowsPipe: openAgentLaunchPipe")
    expect(source).toContain('socket.write(marker, "utf8"')
    expect(source).toContain('socket.end(marker, "utf8"')

    const serviceReady = source.indexOf(
      "const started = await startPetServices(petByokSecretSlot)"
    )
    const bootstrapLoaded = source.indexOf(
      "await view.webContents.loadURL(started.bootstrapUrl)",
      serviceReady
    )
    const authenticatedPetLoaded = source.indexOf(
      "await view.webContents.loadURL(petViewUrl(`${started.origin}/`))",
      bootstrapLoaded
    )
    const shellReady = source.indexOf(
      'shellStatus = Object.freeze({ kind: "ready" })',
      authenticatedPetLoaded
    )
    const shellLoaded = source.indexOf("await loadShell()", shellReady)
    const finalStartupFence = source.indexOf(
      "if (startupLifecycle.shutdownRequested() || services !== started) return",
      shellLoaded
    )
    const readinessReported = source.indexOf(
      "await agentLaunchReady.reportReady()",
      finalStartupFence
    )

    expect([
      serviceReady,
      bootstrapLoaded,
      authenticatedPetLoaded,
      shellReady,
      shellLoaded,
      finalStartupFence,
      readinessReported
    ]).not.toContain(-1)
    expect(serviceReady).toBeLessThan(bootstrapLoaded)
    expect(bootstrapLoaded).toBeLessThan(authenticatedPetLoaded)
    expect(authenticatedPetLoaded).toBeLessThan(shellReady)
    expect(shellReady).toBeLessThan(shellLoaded)
    expect(shellLoaded).toBeLessThan(finalStartupFence)
    expect(finalStartupFence).toBeLessThan(readinessReported)
    expect(source.match(/agentLaunchReady\.reportReady\(\)/gu)).toHaveLength(1)
  })
})
