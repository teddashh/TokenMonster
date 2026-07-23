import { readFile } from "node:fs/promises"

import { describe, expect, it, vi } from "vitest"

import {
  AGENT_LAUNCH_READY_FD,
  AGENT_LAUNCH_READY_MARKER,
  createAgentLaunchReadyReporter,
  installAgentParentDisconnectGuard
} from "../src/main/agent-launch.js"

function reporter(
  environment: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  packaged = false
): Readonly<{
  reportReady(): boolean
  writeWindowsPipe: ReturnType<
    typeof vi.fn<(fd: number, marker: string) => boolean>
  >
  write: ReturnType<typeof vi.fn<(marker: string) => void>>
}> {
  const writeWindowsPipe = vi.fn<(fd: number, marker: string) => boolean>(
    () => true
  )
  const write = vi.fn<(marker: string) => void>()
  const ready = createAgentLaunchReadyReporter({
    environment,
    argv,
    packaged,
    platform: "linux",
    writeWindowsPipe,
    write
  })
  return Object.freeze({
    reportReady: ready.reportReady,
    writeWindowsPipe,
    write
  })
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
  ])("does not report for $name activation", ({ environment, argv }) => {
    const ready = reporter(environment, argv)

    expect(ready.reportReady()).toBe(false)
    expect(ready.write).not.toHaveBeenCalled()
  })

  it("reports the exact fixed marker when both source gates are active", () => {
    const ready = reporter(
      { TOKENMONSTER_AGENT_LAUNCH: "1" },
      ["electron", ".", "--tokenmonster-agent-launch"]
    )

    expect(ready.reportReady()).toBe(true)
    expect(ready.write).toHaveBeenCalledOnce()
    expect(ready.write).toHaveBeenCalledWith(
      "[TOKENMONSTER_AGENT] READY companion\n"
    )
    expect(AGENT_LAUNCH_READY_MARKER).toBe(
      "[TOKENMONSTER_AGENT] READY companion\n"
    )
    expect(ready.writeWindowsPipe).not.toHaveBeenCalled()
  })

  it("uses one exact inherited pipe write instead of stdout on Windows", () => {
    const writeWindowsPipe = vi.fn<
      (fd: number, marker: string) => boolean
    >(
      () => true
    )
    const write = vi.fn<(marker: string) => void>()
    const ready = createAgentLaunchReadyReporter({
      environment: { TOKENMONSTER_AGENT_LAUNCH: "1" },
      argv: ["electron", ".", "--tokenmonster-agent-launch"],
      packaged: false,
      platform: "win32",
      writeWindowsPipe,
      write
    })

    expect(ready.reportReady()).toBe(true)
    expect(writeWindowsPipe).toHaveBeenCalledOnce()
    expect(writeWindowsPipe).toHaveBeenCalledWith(
      4,
      "[TOKENMONSTER_AGENT] READY companion\n"
    )
    expect(AGENT_LAUNCH_READY_FD).toBe(4)
    expect(write).not.toHaveBeenCalled()
  })

  it("fails closed when the Windows readiness pipe is unavailable", () => {
    const writeWindowsPipe = vi.fn<
      (fd: number, marker: string) => boolean
    >(
      () => false
    )
    const write = vi.fn<(marker: string) => void>()
    const ready = createAgentLaunchReadyReporter({
      environment: { TOKENMONSTER_AGENT_LAUNCH: "1" },
      argv: ["--tokenmonster-agent-launch"],
      packaged: false,
      platform: "win32",
      writeWindowsPipe,
      write
    })

    expect(ready.reportReady()).toBe(false)
    expect(ready.reportReady()).toBe(false)
    expect(writeWindowsPipe).toHaveBeenCalledTimes(2)
    expect(write).not.toHaveBeenCalled()
  })

  it("never reports from a packaged app", () => {
    const ready = reporter(
      { TOKENMONSTER_AGENT_LAUNCH: "1" },
      ["--tokenmonster-agent-launch"],
      true
    )

    expect(ready.reportReady()).toBe(false)
    expect(ready.write).not.toHaveBeenCalled()
  })

  it("reports at most once in the same run", () => {
    const ready = reporter(
      { TOKENMONSTER_AGENT_LAUNCH: "1" },
      ["--tokenmonster-agent-launch"]
    )

    expect(ready.reportReady()).toBe(true)
    expect(ready.reportReady()).toBe(false)
    expect(ready.reportReady()).toBe(false)
    expect(ready.write).toHaveBeenCalledOnce()
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
    const squirrel = source.indexOf(
      "handleDefaultSquirrelStartup",
      guard
    )
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

  it("reports only after services, authenticated pet view, and shell are ready", async () => {
    const source = await readFile(
      new URL("../src/main/pet/pet.ts", import.meta.url),
      "utf8"
    )
    expect(source).toContain("environment: process.env")
    expect(source).toContain("argv: process.argv")
    expect(source).toContain("packaged: app.isPackaged")
    expect(source).toContain("platform: process.platform")
    expect(source).toContain("writeSync(fd, marker")

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
      "agentLaunchReady.reportReady()",
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
