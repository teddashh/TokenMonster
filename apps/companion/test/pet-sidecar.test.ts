import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  UTILITY_PROCESS_COMMAND,
  createUtilityChildProcess,
  createUtilityProcessSpawn,
  utilityProcessSpawn,
  type UtilityProcessFork,
  type UtilityProcessLike
} from "../src/main/pet/sidecar.js";
import type { TokenTrackerSpawnOptions } from "@tokenmonster/token-tracker-runtime";

class FakeUtility extends EventEmitter {
  public pid: number | undefined = 4321;
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly killCalls: number[] = [];

  public kill(): boolean {
    this.killCalls.push(this.killCalls.length + 1);
    return true;
  }

  public emitExit(code: number | null): void {
    this.emit("exit", code);
  }

  public asUtilityProcess(): UtilityProcessLike {
    return this as unknown as UtilityProcessLike;
  }
}

function spawnOptions(
  stdio: TokenTrackerSpawnOptions["stdio"]
): TokenTrackerSpawnOptions {
  return {
    env: { KEEP: "present", DROP: undefined },
    shell: false,
    detached: false,
    windowsHide: true,
    stdio
  };
}

describe("Electron utility-process facade", () => {
  it("delivers version stdout before exit and close", async () => {
    const utility = new FakeUtility();
    let forkCall:
      | Readonly<{
          modulePath: string;
          args: readonly string[];
          options: Parameters<UtilityProcessFork>[2];
        }>
      | undefined;
    const spawn = createUtilityProcessSpawn(
      (modulePath, args, options) => {
        forkCall = { modulePath, args, options };
        return utility.asUtilityProcess();
      },
      () => "/app/dist/main/main/sidecar-shim.cjs"
    );
    const child = spawn(
      UTILITY_PROCESS_COMMAND,
      ["/sidecar/bin/tracker.js", "--version"],
      spawnOptions(["ignore", "pipe", "pipe"])
    );
    const events: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      events.push(`data:${chunk.toString("utf8")}`);
    });
    child.stderr?.resume();
    child.on("exit", () => events.push("exit"));
    child.on("close", () => events.push("close"));
    const closed = once(child, "close");

    utility.stdout.end("v0.80.0\n");
    utility.stderr.end();
    utility.emitExit(0);
    await closed;

    expect(events).toEqual(["data:v0.80.0\n", "exit", "close"]);
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
    expect(child.pid).toBe(4321);
    expect(forkCall).toEqual({
      modulePath: "/app/dist/main/main/sidecar-shim.cjs",
      args: ["/sidecar/bin/tracker.js", "--version"],
      options: {
        stdio: ["ignore", "pipe", "pipe"],
        env: { KEEP: "present" },
        serviceName: "tokentracker-sidecar"
      }
    });
  });

  it("reports an unknown exit code as failure, not success", async () => {
    const utility = new FakeUtility();
    const child = createUtilityChildProcess(
      utility.asUtilityProcess(),
      null,
      null
    );
    const closed = once(child, "close");
    const exits: Array<readonly [number | null, NodeJS.Signals | null]> = [];
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      exits.push([code, signal]);
    });

    utility.emitExit(null);

    expect(await closed).toEqual([1, null]);
    expect(exits).toEqual([[1, null]]);
    expect(child.exitCode).toBe(1);
    expect(child.signalCode).toBeNull();
  });

  it("waits for both piped streams to end before close", async () => {
    const utility = new FakeUtility();
    const child = createUtilityChildProcess(
      utility.asUtilityProcess(),
      utility.stdout,
      utility.stderr
    );
    const close = vi.fn();
    child.on("close", close);
    utility.stdout.resume();
    utility.stderr.resume();

    utility.stdout.end();
    await vi.waitFor(() => expect(utility.stdout.readableEnded).toBe(true));
    expect(close).not.toHaveBeenCalled();
    utility.stderr.end();
    await vi.waitFor(() => expect(utility.stderr.readableEnded).toBe(true));
    expect(close).not.toHaveBeenCalled();
    utility.emitExit(7);
    expect(close).toHaveBeenCalledWith(7, null);
  });

  it("force-releases streams that never signal EOF after exit", async () => {
    // Electron's utilityProcess streams do not emit 'end'/'close' when the
    // child exits; the facade must still deliver pending data and close.
    const utility = new FakeUtility();
    const child = createUtilityChildProcess(
      utility.asUtilityProcess(),
      utility.stdout,
      utility.stderr
    );
    const chunks: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      chunks.push(chunk.toString("utf8"));
    });
    child.stderr?.resume();
    const closed = once(child, "close");

    utility.stdout.write("v0.80.0\n");
    utility.emitExit(0);

    expect(await closed).toEqual([0, null]);
    expect(chunks.join("")).toBe("v0.80.0\n");
    expect(utility.stdout.destroyed).toBe(true);
    expect(utility.stderr.destroyed).toBe(true);
    expect(child.exitCode).toBe(0);
  });

  it("closes immediately after exit when stdio is ignored", () => {
    const utility = new FakeUtility();
    const spawn = createUtilityProcessSpawn(
      () => utility.asUtilityProcess(),
      () => "/app/dist/main/main/sidecar-shim.cjs"
    );
    const child = spawn(
      UTILITY_PROCESS_COMMAND,
      ["/sidecar/bin/tracker.js", "sync"],
      spawnOptions("ignore")
    );
    const events: string[] = [];
    child.on("exit", () => events.push("exit"));
    child.on("close", () => events.push("close"));

    utility.emitExit(0);

    expect(child.stdout).toBeNull();
    expect(child.stderr).toBeNull();
    expect(events).toEqual(["exit", "close"]);
  });

  it("kills gracefully for SIGTERM and escalates SIGKILL past utility.kill", () => {
    const utility = new FakeUtility();
    const child = createUtilityChildProcess(
      utility.asUtilityProcess(),
      null,
      null
    );
    const processKill = vi
      .spyOn(process, "kill")
      .mockReturnValue(true as never);
    try {
      expect(child.kill("SIGTERM")).toBe(true);
      expect(utility.killCalls).toHaveLength(1);
      expect(processKill).not.toHaveBeenCalled();

      expect(child.kill("SIGKILL")).toBe(true);
      expect(processKill).toHaveBeenCalledWith(4321, "SIGKILL");
      expect(utility.killCalls).toHaveLength(1);

      utility.emitExit(0);
      expect(child.kill("SIGTERM")).toBe(false);
      expect(utility.killCalls).toHaveLength(1);
    } finally {
      processKill.mockRestore();
    }
  });

  it("falls back to utility.kill when SIGKILL escalation is unavailable", () => {
    const throwing = new FakeUtility();
    const throwingChild = createUtilityChildProcess(
      throwing.asUtilityProcess(),
      null,
      null
    );
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    try {
      expect(throwingChild.kill("SIGKILL")).toBe(true);
      expect(throwing.killCalls).toHaveLength(1);
    } finally {
      processKill.mockRestore();
    }

    const pidless = new FakeUtility();
    pidless.pid = undefined;
    const pidlessChild = createUtilityChildProcess(
      pidless.asUtilityProcess(),
      null,
      null
    );
    expect(pidlessChild.kill("SIGKILL")).toBe(true);
    expect(pidless.killCalls).toHaveLength(1);
  });

  it("rejects any command other than the utility-process marker", () => {
    expect(() =>
      utilityProcessSpawn(
        process.execPath,
        ["/sidecar/bin/tracker.js"],
        spawnOptions("ignore")
      )
    ).toThrow("Unexpected TokenTracker utility-process command.");
  });

  it("forwards utility errors as Error objects", () => {
    const utility = new FakeUtility();
    const child = createUtilityChildProcess(
      utility.asUtilityProcess(),
      null,
      null
    );
    const error = vi.fn();
    child.on("error", error);

    utility.emit("error", "FatalError");

    expect(error).toHaveBeenCalledWith(expect.any(Error));
  });
});
