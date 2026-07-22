import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, parse as parsePath } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  TokenMonsterRuntimeLeaseError,
  acquireTokenMonsterRuntimeLease,
  tokenMonsterRuntimeLeaseIdentifier,
} from "../src/index.js";

const temporaryDirectories: string[] = [];
const liveChildren = new Set<ChildProcess>();
const DARWIN_LEASE_PORT_BASE = 42_000;
const DARWIN_LEASE_PORT_COUNT = 6_000;
const CONCURRENT_CONTENDERS = 12;
const CRASH_STRESS_ROUNDS = 12;

afterEach(async () => {
  for (const child of liveChildren) child.kill("SIGKILL");
  liveChildren.clear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
  );
});

async function fixture(): Promise<
  Readonly<{
    root: string;
    scopeDirectory: string;
  }>
> {
  const root = await mkdtemp(
    join(tmpdir(), "tokenmonster-runtime-lease-test-"),
  );
  temporaryDirectories.push(root);
  return Object.freeze({ root, scopeDirectory: join(root, "private-state") });
}

function launchLeaseOwner(
  scopeDirectory: string,
  platform: NodeJS.Platform,
  temporaryDirectory: string,
): Readonly<{ child: ChildProcess; outcome: Promise<string> }> {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("runtime-lease-child.mjs", import.meta.url)),
      scopeDirectory,
      platform,
      temporaryDirectory,
    ],
    {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  liveChildren.add(child);
  const outcome = Promise.race([
    once(child.stdout!, "data").then(([chunk]) => String(chunk)),
    // `close` follows stdio drain; using `exit` can win the race against the
    // sanitized error line on Windows even though the child wrote it.
    once(child, "close").then(([code]) => `EXIT:${String(code)}`),
  ]);
  return Object.freeze({ child, outcome });
}

async function killLeaseOwner(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  liveChildren.delete(child);
}

async function crashLeaseOwner(
  scopeDirectory: string,
  platform: NodeJS.Platform,
  temporaryDirectory: string,
): Promise<void> {
  const launched = launchLeaseOwner(
    scopeDirectory,
    platform,
    temporaryDirectory,
  );
  const output = await launched.outcome;
  expect(output).toContain("TOKENMONSTER_LEASE_READY");
  await killLeaseOwner(launched.child);
}

function darwinLeasePort(scopeDirectory: string): number {
  const identifier = tokenMonsterRuntimeLeaseIdentifier(scopeDirectory);
  return (
    DARWIN_LEASE_PORT_BASE +
    (Number.parseInt(identifier.slice(-8), 16) % DARWIN_LEASE_PORT_COUNT)
  );
}

async function closeTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

describe("user-scoped TokenMonster runtime lease", () => {
  it("allows only one owner, sanitizes contention, and releases idempotently", async () => {
    const input = await fixture();
    const lease = await acquireTokenMonsterRuntimeLease({
      scopeDirectory: input.scopeDirectory,
    });

    let contention: unknown;
    try {
      await acquireTokenMonsterRuntimeLease({
        scopeDirectory: input.scopeDirectory,
      });
    } catch (error) {
      contention = error;
    }
    expect(contention).toBeInstanceOf(TokenMonsterRuntimeLeaseError);
    expect(contention).toMatchObject({ code: "already-running" });
    expect(String(contention)).not.toContain(input.root);

    await expect(
      Promise.all([lease.release(), lease.release()]),
    ).resolves.toEqual([undefined, undefined]);
    const replacement = await acquireTokenMonsterRuntimeLease({
      scopeDirectory: input.scopeDirectory,
    });
    await replacement.release();
  });

  it("uses a stable opaque identifier rather than a username or local path", async () => {
    const input = await fixture();
    const identifier = tokenMonsterRuntimeLeaseIdentifier(input.scopeDirectory);

    expect(identifier).toMatch(/^tm-runtime-v1-[0-9a-f]{32}$/u);
    expect(identifier).not.toContain(input.root);
    expect(identifier).not.toContain("private-state");
    expect(tokenMonsterRuntimeLeaseIdentifier(input.scopeDirectory)).toBe(
      identifier,
    );
  });

  it("canonicalizes symlink spellings to one scope and reacquires through an alias", async () => {
    const input = await fixture();
    const actualHome = join(input.root, "actual-home");
    const aliasHome = join(input.root, "alias-home");
    const actualScope = join(actualHome, ".tokenmonster");
    const parentAliasScope = join(aliasHome, ".tokenmonster");
    const finalAliasScope = join(input.root, "scope-alias");
    await mkdir(actualScope, { recursive: true, mode: 0o700 });
    await symlink(
      actualHome,
      aliasHome,
      process.platform === "win32" ? "junction" : "dir",
    );
    await symlink(
      actualScope,
      finalAliasScope,
      process.platform === "win32" ? "junction" : "dir",
    );

    const owner = await acquireTokenMonsterRuntimeLease({
      scopeDirectory: actualScope,
    });
    for (const alias of [parentAliasScope, finalAliasScope]) {
      await expect(
        acquireTokenMonsterRuntimeLease({ scopeDirectory: alias }),
      ).rejects.toMatchObject({ code: "already-running" });
    }
    await owner.release();

    const replacement = await acquireTokenMonsterRuntimeLease({
      scopeDirectory: finalAliasScope,
    });
    await replacement.release();
  });

  it("folds Windows drive and path casing in the identifier authority", () => {
    expect(
      tokenMonsterRuntimeLeaseIdentifier(
        "C:\\Users\\Player\\.tokenmonster",
        "win32",
      ),
    ).toBe(
      tokenMonsterRuntimeLeaseIdentifier(
        "c:\\users\\PLAYER\\.TOKENMONSTER",
        "win32",
      ),
    );
  });

  it("rejects root and special-file scopes with sanitized errors", async () => {
    const input = await fixture();
    const special = join(input.root, "not-a-directory");
    await writeFile(special, input.root, { mode: 0o600 });

    for (const scopeDirectory of [parsePath(input.root).root, special]) {
      let failure: unknown;
      try {
        await acquireTokenMonsterRuntimeLease({ scopeDirectory });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "lease-unavailable" });
      expect(String(failure)).not.toContain(input.root);
    }
  });

  it("is released by the OS after an owning process dies", async () => {
    const input = await fixture();
    await crashLeaseOwner(input.scopeDirectory, process.platform, input.root);

    const replacement = await acquireTokenMonsterRuntimeLease({
      scopeDirectory: input.scopeDirectory,
      temporaryDirectory: input.root,
    });
    await replacement.release();
  });

  it("reacquires the macOS loopback lease after an abrupt owner crash", async () => {
    const input = await fixture();
    await crashLeaseOwner(input.scopeDirectory, "darwin", input.root);

    const replacement = await acquireTokenMonsterRuntimeLease({
      scopeDirectory: input.scopeDirectory,
      platform: "darwin",
      temporaryDirectory: input.root,
    });
    await replacement.release();
  });

  it("keeps exactly one macOS owner across repeated crash races", async () => {
    const input = await fixture();
    let owner = launchLeaseOwner(input.scopeDirectory, "darwin", input.root);
    expect(await owner.outcome).toContain("TOKENMONSTER_LEASE_READY");

    for (let round = 0; round < CRASH_STRESS_ROUNDS; round += 1) {
      await killLeaseOwner(owner.child);
      const contenders = Array.from({ length: CONCURRENT_CONTENDERS }, () =>
        launchLeaseOwner(input.scopeDirectory, "darwin", input.root),
      );
      const outcomes = await Promise.all(
        contenders.map(async (contender) => await contender.outcome),
      );
      const winners = contenders.filter((_contender, index) =>
        outcomes[index]?.includes("TOKENMONSTER_LEASE_READY"),
      );
      expect(winners, `crash race round ${round}`).toHaveLength(1);
      const loserOutcomes = outcomes.filter(
        (outcome) => !outcome.includes("TOKENMONSTER_LEASE_READY"),
      );
      expect(loserOutcomes, `crash race round ${round}`).toHaveLength(
        CONCURRENT_CONTENDERS - 1,
      );
      for (const outcome of loserOutcomes) {
        expect(outcome.trim(), `crash race round ${round}`).toMatch(
          /^TOKENMONSTER_LEASE_ERROR:(?:already-running|lease-unavailable)$/u,
        );
      }
      owner = winners[0]!;
      await Promise.all(
        contenders
          .filter((contender) => contender !== owner)
          .map(async (contender) => await killLeaseOwner(contender.child)),
      );
    }
    await killLeaseOwner(owner.child);
  }, 30_000);

  it("fails closed when the deterministic macOS port speaks another protocol", async () => {
    const input = await fixture();
    await mkdir(input.scopeDirectory, { mode: 0o700 });
    const canonicalScope = await realpath(input.scopeDirectory);
    const foreign = createServer((socket) => socket.end("NOT_TOKENMONSTER\n"));
    await new Promise<void>((resolve, reject) => {
      foreign.once("error", reject);
      foreign.listen(
        { host: "127.0.0.1", port: darwinLeasePort(canonicalScope) },
        resolve,
      );
    });
    try {
      await expect(
        acquireTokenMonsterRuntimeLease({
          scopeDirectory: input.scopeDirectory,
          platform: "darwin",
        }),
      ).rejects.toMatchObject({ code: "lease-unavailable" });
    } finally {
      await closeTestServer(foreign);
    }
  });

  it("binds a macOS port collision to the exact opaque scope", async () => {
    const input = await fixture();
    const canonicalRoot = await realpath(input.root);
    const scopesByPort = new Map<number, string>();
    let collision: readonly [string, string] | null = null;
    for (let index = 0; index <= DARWIN_LEASE_PORT_COUNT; index += 1) {
      const scope = join(canonicalRoot, `collision-scope-${index}`);
      const port = darwinLeasePort(scope);
      const existing = scopesByPort.get(port);
      if (existing !== undefined) {
        collision = Object.freeze([existing, scope] as const);
        break;
      }
      scopesByPort.set(port, scope);
    }
    expect(collision).not.toBeNull();
    const owner = await acquireTokenMonsterRuntimeLease({
      scopeDirectory: collision![0],
      platform: "darwin",
    });
    try {
      await expect(
        acquireTokenMonsterRuntimeLease({
          scopeDirectory: collision![1],
          platform: "darwin",
        }),
      ).rejects.toMatchObject({ code: "lease-unavailable" });
    } finally {
      await owner.release();
    }
  });
});
