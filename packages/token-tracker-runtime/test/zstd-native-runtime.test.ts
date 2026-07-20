import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PINNED_TOKEN_TRACKER_VERSION } from "../src/constants.js";
import {
  resolveTokenTrackerExecutableFromManifest,
  startManagedTokenTracker
} from "../src/runtime.js";
import type {
  TokenTrackerSpawn,
  TokenTrackerSpawnOptions
} from "../src/types.js";

const directories: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const workspaceBinding = join(
  repositoryRoot,
  "node_modules",
  "@mongodb-js",
  "zstd",
  "build",
  "Release",
  "zstd.node"
);

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

interface NativeRuntimeFixture {
  readonly root: string;
  readonly manifestPath: string;
  readonly entryPath: string;
  readonly bindingPath: string;
}

async function nativeRuntimeFixture(): Promise<NativeRuntimeFixture> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tokenmonster-native-runtime-"))
  );
  directories.push(root);
  const sidecarRoot = join(root, "tokentracker-cli");
  const manifestPath = join(sidecarRoot, "package.json");
  const entryPath = join(sidecarRoot, "bin", "tracker.js");
  const zstdRoot = join(
    sidecarRoot,
    "node_modules",
    "@mongodb-js",
    "zstd"
  );
  const bindingPath = join(zstdRoot, "build", "Release", "zstd.node");
  await mkdir(dirname(entryPath), { recursive: true });
  await mkdir(dirname(bindingPath), { recursive: true });
  await writeFile(entryPath, "#!/usr/bin/env node\n");
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      name: "tokentracker-cli",
      version: PINNED_TOKEN_TRACKER_VERSION,
      bin: { "tokentracker-cli": "bin/tracker.js" },
      dependencies: { "@mongodb-js/zstd": "^2.0.1" }
    })}\n`
  );
  await writeFile(
    join(zstdRoot, "package.json"),
    `${JSON.stringify({ name: "@mongodb-js/zstd", version: "2.0.1" })}\n`
  );
  await copyFile(workspaceBinding, bindingPath);
  return Object.freeze({ root, manifestPath, entryPath, bindingPath });
}

class FakeChild extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public onSpawn: (() => void) | undefined;

  public emitExit(
    code: number | null,
    signal: NodeJS.Signals | null = null
  ): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }

  public kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    queueMicrotask(() => this.emitExit(null, signal));
    return true;
  }

  public asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

function successfulVersionChild(): FakeChild {
  const child = new FakeChild();
  child.onSpawn = () => {
    child.stdout.end(`v${PINNED_TOKEN_TRACKER_VERSION}\n`);
    child.stderr.end();
    child.emitExit(0);
  };
  return child;
}

function announcedServerChild(): FakeChild {
  const child = new FakeChild();
  child.onSpawn = () => {
    child.stdout.write("TokenTracker ready at http://127.0.0.1:7680/\n");
  };
  return child;
}

function queuedSpawn(children: readonly FakeChild[]): Readonly<{
  spawn: TokenTrackerSpawn;
  calls: ReadonlyArray<{
    command: string;
    arguments_: readonly string[];
    options: TokenTrackerSpawnOptions;
  }>;
}> {
  const queue = [...children];
  const calls: Array<{
    command: string;
    arguments_: readonly string[];
    options: TokenTrackerSpawnOptions;
  }> = [];
  const spawn: TokenTrackerSpawn = (command, arguments_, options) => {
    const child = queue.shift();
    if (child === undefined) throw new Error("Unexpected spawn");
    calls.push({ command, arguments_: [...arguments_], options });
    queueMicrotask(() => child.onSpawn?.());
    return child.asChildProcess();
  };
  return Object.freeze({ spawn, calls });
}

function startWithFixture(
  fixture: NativeRuntimeFixture,
  spawn: TokenTrackerSpawn,
  platform: string = process.platform,
  arch: string = process.arch
) {
  return startManagedTokenTracker({
    readinessProbe: async () => undefined,
    refreshIntervalMs: false,
    spawn,
    resolveExecutable: () =>
      resolveTokenTrackerExecutableFromManifest(
        fixture.manifestPath,
        platform,
        arch
      )
  });
}

describe("runtime zstd authenticity gate", () => {
  it("verifies the installed native binding before normal version and server spawns", async () => {
    const fixture = await nativeRuntimeFixture();
    const processQueue = queuedSpawn([
      successfulVersionChild(),
      announcedServerChild()
    ]);
    const runtime = await startWithFixture(fixture, processQueue.spawn);

    expect(processQueue.calls).toHaveLength(2);
    expect(processQueue.calls.map(({ arguments_ }) => arguments_)).toEqual([
      [
        "--require",
        expect.stringMatching(/network-deny\.cjs$/u),
        fixture.entryPath,
        "--version"
      ],
      [
        "--require",
        expect.stringMatching(/network-deny\.cjs$/u),
        fixture.entryPath,
        "serve",
        "--no-open",
        "--no-sync"
      ]
    ]);
    await runtime.stop();
  });

  it("rejects a same-size substituted binding with zero child spawns", async () => {
    const fixture = await nativeRuntimeFixture();
    const bytes = await readFile(fixture.bindingPath);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    await writeFile(fixture.bindingPath, bytes);
    const spawn = vi.fn<TokenTrackerSpawn>();

    await expect(startWithFixture(fixture, spawn)).rejects.toMatchObject({
      code: "sidecar-incompatible",
      message: "The managed TokenTracker API is incompatible."
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a missing binding with zero child spawns", async () => {
    const fixture = await nativeRuntimeFixture();
    await rm(fixture.bindingPath);
    const spawn = vi.fn<TokenTrackerSpawn>();

    await expect(startWithFixture(fixture, spawn)).rejects.toMatchObject({
      code: "sidecar-incompatible"
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects an unsupported platform with zero child spawns", async () => {
    const fixture = await nativeRuntimeFixture();
    const spawn = vi.fn<TokenTrackerSpawn>();

    await expect(
      startWithFixture(fixture, spawn, "freebsd", "x64")
    ).rejects.toMatchObject({ code: "sidecar-incompatible" });
    expect(spawn).not.toHaveBeenCalled();
  });
});
