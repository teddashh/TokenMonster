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
    const spawn = createUtilityProcessSpawn((modulePath, args, options) => {
      forkCall = { modulePath, args, options };
      return utility.asUtilityProcess();
    });
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
      modulePath: "/sidecar/bin/tracker.js",
      args: ["--version"],
      options: {
        stdio: ["ignore", "pipe", "pipe"],
        env: { KEEP: "present" },
        serviceName: "tokentracker-sidecar"
      }
    });
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

    utility.emitExit(7);
    expect(close).not.toHaveBeenCalled();
    utility.stdout.end();
    await vi.waitFor(() => expect(utility.stdout.readableEnded).toBe(true));
    expect(close).not.toHaveBeenCalled();
    utility.stderr.end();
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith(7, null));
  });

  it("closes immediately after exit when stdio is ignored", () => {
    const utility = new FakeUtility();
    const spawn = createUtilityProcessSpawn(() => utility.asUtilityProcess());
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

  it("maps every signal to utility kill and makes post-exit kills safe", () => {
    const utility = new FakeUtility();
    const child = createUtilityChildProcess(
      utility.asUtilityProcess(),
      null,
      null
    );

    expect(child.kill("SIGKILL")).toBe(true);
    expect(utility.killCalls).toHaveLength(1);
    utility.emitExit(0);
    expect(child.kill("SIGTERM")).toBe(false);
    expect(utility.killCalls).toHaveLength(1);
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
