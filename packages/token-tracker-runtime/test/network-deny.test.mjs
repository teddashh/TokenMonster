import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { requireDisabledRemoteLimitsResponse } from "../../../scripts/release/smoke-installed-policy.mjs";

const execFileAsync = promisify(execFile);
const guardPath = fileURLToPath(
  new URL("../src/network-deny.cjs", import.meta.url),
);

const probe = String.raw`
"use strict";
const dgram = require("node:dgram");
const childProcess = require("node:child_process");
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const workerThreads = require("node:worker_threads");
const { ERROR_CODE } = require(${JSON.stringify(guardPath)});

function codeFrom(call) {
  try {
    const value = call();
    if (value && typeof value.catch === "function") {
      return value.then(
        () => "allowed",
        (error) => error && error.code,
      );
    }
    value && value.close && value.close();
    return "allowed";
  } catch (error) {
    return error && error.code;
  }
}

function lockedResolveSurface(target) {
  const properties = Object.getOwnPropertyNames(target)
    .filter((property) => /^resolve/u.test(property))
    .sort();
  return {
    properties,
    allLocked: properties.length > 0 && properties.every((property) => {
      const descriptor = Object.getOwnPropertyDescriptor(target, property);
      return descriptor && descriptor.configurable === false &&
        descriptor.writable === false && typeof descriptor.value === "function";
    }),
  };
}

const server = http.createServer((_request, response) => response.end("ok"));
server.listen(0, "127.0.0.1", async () => {
  const results = await Promise.all([
    codeFrom(() => fetch("http://127.0.0.1:9")),
    codeFrom(() => http.get("http://127.0.0.1:9")),
    codeFrom(() => https.get("https://127.0.0.1:9")),
    codeFrom(() => net.connect(9, "127.0.0.1")),
    codeFrom(() => dns.lookup("192.0.2.1", () => undefined)),
    codeFrom(() => {
      const resolver = new dns.promises.Resolver();
      resolver.setServers(["127.0.0.1:9"]);
      return resolver.resolve4("example.invalid");
    }),
    codeFrom(() => dns.resolveTlsa("example.invalid", () => undefined)),
    codeFrom(() => dns.promises.resolveTlsa("example.invalid")),
    codeFrom(() => new dns.Resolver().resolveTlsa("example.invalid", () => undefined)),
    codeFrom(() => new dns.promises.Resolver().resolveTlsa("example.invalid")),
    codeFrom(() => dgram.createSocket("udp4")),
    codeFrom(() => dgram.Socket.prototype.sendto.call({}, Buffer.from("x"), 9, "127.0.0.1")),
    codeFrom(() => childProcess.exec("true")),
    codeFrom(() => childProcess.execFile("true")),
    codeFrom(() => childProcess.execFileSync("true")),
    codeFrom(() => childProcess.execSync("true")),
    codeFrom(() => childProcess.fork("missing.js")),
    codeFrom(() => childProcess.spawn("true")),
    codeFrom(() => childProcess.spawnSync("true")),
    codeFrom(() => new childProcess.ChildProcess().spawn({
      file: process.execPath,
      args: [process.execPath, "--version"],
      envPairs: [],
      stdio: "ignore",
      detached: false,
      windowsHide: true,
      windowsVerbatimArguments: false,
    })),
    codeFrom(() => new workerThreads.Worker("", { eval: true })),
  ]);
  const surfaces = [
    lockedResolveSurface(dns),
    lockedResolveSurface(dns.promises),
    lockedResolveSurface(dns.Resolver.prototype),
    lockedResolveSurface(dns.promises.Resolver.prototype),
  ];
  let overwrite = "allowed";
  try {
    globalThis.fetch = async () => ({ ok: true });
  } catch (error) {
    overwrite = error && error.name;
  }
  server.close(() => {
    const launcherProperties = [
      "exec",
      "execFile",
      "execFileSync",
      "execSync",
      "fork",
      "spawn",
      "spawnSync",
    ];
    const launchersLocked = launcherProperties.every((property) => {
      const descriptor = Object.getOwnPropertyDescriptor(childProcess, property);
      return descriptor && descriptor.configurable === false &&
        descriptor.writable === false && typeof descriptor.value === "function";
    });
    const workerDescriptor = Object.getOwnPropertyDescriptor(workerThreads, "Worker");
    const childSpawnDescriptor = Object.getOwnPropertyDescriptor(
      childProcess.ChildProcess.prototype,
      "spawn",
    );
    process.stdout.write(JSON.stringify({
      ERROR_CODE,
      overwrite,
      results,
      surfaces,
      launchersLocked,
      childSpawnLocked: childSpawnDescriptor &&
        childSpawnDescriptor.configurable === false &&
        childSpawnDescriptor.writable === false &&
        typeof childSpawnDescriptor.value === "function",
      workerLocked: workerDescriptor && workerDescriptor.configurable === false &&
        workerDescriptor.writable === false && typeof workerDescriptor.value === "function",
    }));
  });
});
`;

describe("sidecar network deny preload", () => {
  it("accepts only the exact platform-specific disabled remote-limits result", () => {
    expect(
      requireDisabledRemoteLimitsResponse({
        body: { error: "TokenMonster blocked sidecar network egress." },
        platform: "darwin",
        status: 500,
      }),
    ).toBe("macos-native-helper-blocked");
    expect(
      requireDisabledRemoteLimitsResponse({
        body: { providers: [] },
        platform: "linux",
        status: 200,
      }),
    ).toBe("neutral-response");

    for (const input of [
      {
        body: { error: "TokenMonster blocked sidecar network egress." },
        platform: "darwin",
        status: 200,
      },
      {
        body: {
          error: "TokenMonster blocked sidecar network egress.",
          extra: true,
        },
        platform: "darwin",
        status: 500,
      },
      {
        body: { error: "different" },
        platform: "darwin",
        status: 500,
      },
      {
        body: { error: "TokenMonster blocked sidecar network egress." },
        platform: "linux",
        status: 500,
      },
    ]) {
      expect(() => requireDisabledRemoteLimitsResponse(input)).toThrow(
        /unexpected HTTP/u,
      );
    }
  });

  it("keeps loopback listening available while denying every outbound primitive", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--require", guardPath, "--eval", probe],
      { timeout: 10_000 },
    );
    expect(stderr).toBe("");
    const output = JSON.parse(stdout);
    expect(output).toMatchObject({
      ERROR_CODE: "TOKENMONSTER_SIDECAR_EGRESS_BLOCKED",
      overwrite: "TypeError",
      results: Array(21).fill("TOKENMONSTER_SIDECAR_EGRESS_BLOCKED"),
      launchersLocked: true,
      childSpawnLocked: true,
      workerLocked: true,
    });
    expect(output.surfaces).toHaveLength(4);
    for (const surface of output.surfaces) {
      expect(surface.allLocked).toBe(true);
      expect(surface.properties).toContain("resolveTlsa");
    }
  });

  it("installs through the internally generated NODE_OPTIONS preload", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--eval",
        'fetch("https://example.invalid").catch((error) => process.stdout.write(`${error.code}\\n`))',
      ],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: `--require=${JSON.stringify(guardPath)}`,
        },
        timeout: 10_000,
      },
    );
    expect(stderr).toBe("");
    expect(stdout).toBe("TOKENMONSTER_SIDECAR_EGRESS_BLOCKED\n");
  });

  it("locks Chromium networking when loaded in an Electron utility context", async () => {
    const electronProbe = String.raw`
      "use strict";
      const Module = require("node:module");
      const originalLoad = Module._load;
      const fakeNet = {
        fetch() { return Promise.resolve("allowed"); },
        request() { return "allowed"; },
        resolveHost() { return Promise.resolve("allowed"); },
      };
      Object.defineProperty(process.versions, "electron", {
        configurable: true,
        value: "43.0.0",
      });
      Module._load = function(request, parent, isMain) {
        return request === "electron/utility"
          ? { net: fakeNet }
          : Reflect.apply(originalLoad, this, [request, parent, isMain]);
      };
      const { ERROR_CODE } = require(${JSON.stringify(guardPath)});
      function codeFrom(call) {
        try {
          const value = call();
          if (value && typeof value.catch === "function") {
            return value.then(() => "allowed", (error) => error && error.code);
          }
          return "allowed";
        } catch (error) {
          return error && error.code;
        }
      }
      Promise.all([
        codeFrom(() => fakeNet.fetch("https://example.invalid")),
        codeFrom(() => fakeNet.request("https://example.invalid")),
        codeFrom(() => fakeNet.resolveHost("example.invalid")),
      ]).then((results) => {
        const locked = ["fetch", "request", "resolveHost"].every((property) => {
          const descriptor = Object.getOwnPropertyDescriptor(fakeNet, property);
          return descriptor && descriptor.configurable === false &&
            descriptor.writable === false && typeof descriptor.value === "function";
        });
        process.stdout.write(JSON.stringify({ ERROR_CODE, locked, results }));
      });
    `;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--eval", electronProbe],
      { timeout: 10_000 },
    );
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      ERROR_CODE: "TOKENMONSTER_SIDECAR_EGRESS_BLOCKED",
      locked: true,
      results: Array(3).fill("TOKENMONSTER_SIDECAR_EGRESS_BLOCKED"),
    });
  });
});
