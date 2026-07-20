import { createHash } from "node:crypto";
import { realpath as realpathCallback } from "node:fs";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import {
  isAbsolute,
  join,
  normalize,
  parse as parsePath,
  win32,
} from "node:path";

const LEASE_PROTOCOL = "TOKENMONSTER_RUNTIME_LEASE_V1\n";
const LEASE_IDENTIFIER_PREFIX = "tm-runtime-v1-";
const LEASE_PROBE_TIMEOUT_MS = 500;
const MAX_ACQUISITION_ATTEMPTS = 4;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;
// One deterministic authority is safer than a fallback port list: if a later
// candidate owned the lease and an earlier foreign listener disappeared, a
// new contender could otherwise bind the earlier candidate and split-brain.
// This registered-range slice avoids macOS's default dynamic-port range. A
// collision fails closed after the exact scope-bound handshake below.
const DARWIN_LEASE_PORT_BASE = 42_000;
const DARWIN_LEASE_PORT_COUNT = 6_000;

export type TokenMonsterRuntimeLeaseErrorCode =
  "already-running" | "lease-unavailable";

const LEASE_ERROR_MESSAGES: Readonly<
  Record<TokenMonsterRuntimeLeaseErrorCode, string>
> = Object.freeze({
  "already-running": "TokenMonster is already running.",
  "lease-unavailable":
    "TokenMonster could not acquire its local runtime lease.",
});

/** Public lease failures deliberately omit usernames, paths, PIDs, and IPC names. */
export class TokenMonsterRuntimeLeaseError extends Error {
  public override readonly name = "TokenMonsterRuntimeLeaseError";
  public readonly code: TokenMonsterRuntimeLeaseErrorCode;

  public constructor(code: TokenMonsterRuntimeLeaseErrorCode) {
    super(LEASE_ERROR_MESSAGES[code]);
    this.code = code;
  }
}

export interface TokenMonsterRuntimeLease {
  release(): Promise<void>;
}

export interface AcquireTokenMonsterRuntimeLeaseOptions {
  /** Shared local state root, normally ~/.tokenmonster. It is hashed, never exposed. */
  readonly scopeDirectory: string;
  readonly platform?: NodeJS.Platform;
  /** Test seam and filesystem Unix-socket parent; not included in the public identifier. */
  readonly temporaryDirectory?: string;
}

type TcpLeaseAddress = Readonly<{
  host: "127.0.0.1";
  port: number;
}>;

type LeaseEndpoint = Readonly<{
  address: string | TcpLeaseAddress;
  filesystemPath: string | null;
  parentDirectory: string | null;
}>;

type SocketIdentity = Readonly<{ device: number; inode: number }>;
type ProbeResult = "active" | "stale" | "unknown";

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function normalizeScopeDirectory(
  scopeDirectory: string,
  pathPlatform: NodeJS.Platform = process.platform,
): string {
  if (typeof scopeDirectory !== "string" || scopeDirectory.includes("\0")) {
    throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
  }
  const pathApi = pathPlatform === "win32" ? win32 : null;
  const absolute =
    pathApi === null
      ? isAbsolute(scopeDirectory)
      : pathApi.isAbsolute(scopeDirectory);
  const normalized =
    pathApi === null
      ? normalize(scopeDirectory)
      : pathApi.normalize(scopeDirectory);
  const root =
    pathApi === null
      ? parsePath(scopeDirectory).root
      : pathApi.parse(scopeDirectory).root;
  if (!absolute || normalized !== scopeDirectory || scopeDirectory === root) {
    throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
  }
  return scopeDirectory;
}

/** Stable and content-blind: callers may log this hash without exposing a path. */
export function tokenMonsterRuntimeLeaseIdentifier(
  scopeDirectory: string,
  pathPlatform: NodeJS.Platform = process.platform,
): string {
  const normalized = normalizeScopeDirectory(scopeDirectory, pathPlatform);
  // Native Windows realpath normally returns the on-disk spelling, but the
  // authority additionally folds case so drive/UNC aliases cannot create two
  // named pipes for the same case-insensitive state directory.
  const authorityPath =
    pathPlatform === "win32" ? normalized.toLowerCase() : normalized;
  const digest = createHash("sha256")
    .update("tokenmonster-runtime-lease-v1\0", "utf8")
    .update(authorityPath, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${LEASE_IDENTIFIER_PREFIX}${digest}`;
}

function nativeRealpath(path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    realpathCallback.native(path, (error, resolved) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(resolved);
    });
  });
}

function scopeMetadataIsOwned(
  metadata: Awaited<ReturnType<typeof lstat>>,
): boolean {
  const getuid = process.getuid;
  return typeof getuid !== "function" || metadata.uid === getuid();
}

function scopeMetadataIsPrivateDirectory(
  metadata: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    scopeMetadataIsOwned(metadata) &&
    !metadata.isSymbolicLink() &&
    metadata.isDirectory()
  );
}

async function prepareCanonicalScopeDirectory(
  scopeDirectory: string,
): Promise<string> {
  const requested = normalizeScopeDirectory(scopeDirectory);
  try {
    await mkdir(requested, { recursive: true, mode: 0o700 });
    const before = await lstat(requested);
    if (
      !scopeMetadataIsOwned(before) ||
      (!before.isDirectory() && !before.isSymbolicLink())
    ) {
      throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
    }

    const canonical = normalizeScopeDirectory(await nativeRealpath(requested));
    const canonicalBefore = await lstat(canonical);
    if (!scopeMetadataIsPrivateDirectory(canonicalBefore)) {
      throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
    }
    const [requestedAfter, canonicalAfter] = await Promise.all([
      lstat(requested),
      lstat(canonical),
    ]);
    if (
      !scopeMetadataIsOwned(requestedAfter) ||
      requestedAfter.isSymbolicLink() !== before.isSymbolicLink() ||
      requestedAfter.isDirectory() !== before.isDirectory() ||
      !scopeMetadataIsPrivateDirectory(canonicalAfter) ||
      requestedAfter.dev !== before.dev ||
      requestedAfter.ino !== before.ino ||
      canonicalAfter.dev !== canonicalBefore.dev ||
      canonicalAfter.ino !== canonicalBefore.ino ||
      (!before.isSymbolicLink() &&
        (canonicalAfter.dev !== before.dev ||
          canonicalAfter.ino !== before.ino))
    ) {
      throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
    }
    await chmod(canonical, 0o700);
    const finalMetadata = await lstat(canonical);
    if (
      !scopeMetadataIsPrivateDirectory(finalMetadata) ||
      finalMetadata.dev !== canonicalBefore.dev ||
      finalMetadata.ino !== canonicalBefore.ino
    ) {
      throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
    }
    return canonical;
  } catch (error) {
    if (error instanceof TokenMonsterRuntimeLeaseError) throw error;
    throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
  }
}

function leaseEndpoint(
  identifier: string,
  platform: NodeJS.Platform,
  temporaryDirectory: string,
): LeaseEndpoint {
  if (platform === "win32") {
    return Object.freeze({
      address: `\\\\.\\pipe\\${identifier}`,
      filesystemPath: null,
      parentDirectory: null,
    });
  }
  if (platform === "linux") {
    // Linux abstract sockets have no filesystem pathname, so SIGKILL and
    // crashes release the lease without leaving anything to recover.
    return Object.freeze({
      address: `\0${identifier}`,
      filesystemPath: null,
      parentDirectory: null,
    });
  }
  if (platform === "darwin") {
    // A loopback TCP listener is an OS-owned, crash-released authority. Unlike
    // a filesystem Unix socket, it never requires a stale pathname unlink and
    // therefore cannot delete a newly rebound owner's endpoint in a recovery
    // race. The protocol binds the finite port namespace back to this scope.
    const digestSuffix = identifier.slice(-8);
    const portOffset =
      Number.parseInt(digestSuffix, 16) % DARWIN_LEASE_PORT_COUNT;
    return Object.freeze({
      address: Object.freeze({
        host: "127.0.0.1" as const,
        port: DARWIN_LEASE_PORT_BASE + portOffset,
      }),
      filesystemPath: null,
      parentDirectory: null,
    });
  }

  const parentDirectory = join(
    temporaryDirectory,
    `.tm-runtime-${identifier.slice(-16)}`,
  );
  const filesystemPath = join(parentDirectory, "lease.sock");
  if (Buffer.byteLength(filesystemPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
  }
  return Object.freeze({
    address: filesystemPath,
    filesystemPath,
    parentDirectory,
  });
}

async function preparePrivateSocketDirectory(
  path: string | null,
): Promise<void> {
  if (path === null) return;
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) {
      throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
    }
  }
  try {
    const metadata = await lstat(path);
    const getuid = process.getuid;
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (typeof getuid === "function" && metadata.uid !== getuid())
    ) {
      throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
    }
    await chmod(path, 0o700);
  } catch (error) {
    if (error instanceof TokenMonsterRuntimeLeaseError) throw error;
    throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
  }
}

function leaseProtocol(identifier: string): string {
  return `${LEASE_PROTOCOL.trimEnd()} ${identifier}\n`;
}

function createLeaseServer(sockets: Set<Socket>, protocol: string): Server {
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.end(protocol, "utf8");
  });
  // Never turn a late local IPC error into an uncaught exception containing a
  // pathname. Acquisition and release surface only sanitized error codes.
  server.on("error", () => undefined);
  return server;
}

async function listen(
  server: Server,
  address: string | TcpLeaseAddress,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if (typeof address === "string") {
      server.listen(address);
    } else {
      server.listen({ ...address, exclusive: true });
    }
  });
}

async function probeLease(
  address: string | TcpLeaseAddress,
  expectedProtocol: string,
): Promise<ProbeResult> {
  return await new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let received = "";
    const socket = createConnection(
      typeof address === "string" ? { path: address } : address,
    );
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish("unknown"), LEASE_PROBE_TIMEOUT_MS);
    timer.unref();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.length > expectedProtocol.length) finish("unknown");
    });
    socket.once("end", () =>
      finish(received === expectedProtocol ? "active" : "unknown"),
    );
    socket.once("error", (error: unknown) => {
      finish(
        hasCode(error, "ENOENT") || hasCode(error, "ECONNREFUSED")
          ? "stale"
          : "unknown",
      );
    });
  });
}

async function socketIdentity(path: string): Promise<SocketIdentity> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isSocket()) {
      throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
    }
    return Object.freeze({ device: metadata.dev, inode: metadata.ino });
  } catch (error) {
    if (error instanceof TokenMonsterRuntimeLeaseError) throw error;
    throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
  }
}

async function recoverStaleFilesystemSocket(
  endpoint: LeaseEndpoint,
  expectedProtocol: string,
): Promise<void> {
  const path = endpoint.filesystemPath;
  if (path === null) return;
  const before = await socketIdentity(path);
  // A second handshake narrows the recovery race and ensures that a server
  // which became reachable after the failed listen is never deliberately
  // removed as stale.
  if ((await probeLease(endpoint.address, expectedProtocol)) !== "stale") {
    throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
  }
  try {
    const after = await lstat(path);
    if (
      after.isSymbolicLink() ||
      !after.isSocket() ||
      after.dev !== before.device ||
      after.ino !== before.inode
    ) {
      throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
    }
    await unlink(path);
  } catch (error) {
    if (error instanceof TokenMonsterRuntimeLeaseError) throw error;
    throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
  }
}

async function closeServer(
  server: Server,
  sockets: Set<Socket>,
): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

async function removeOwnedSocketPath(
  path: string | null,
  identity: SocketIdentity | null,
): Promise<void> {
  if (path === null || identity === null) return;
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isSymbolicLink() &&
      metadata.isSocket() &&
      metadata.dev === identity.device &&
      metadata.ino === identity.inode
    ) {
      await unlink(path);
    }
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
    }
  }
}

/**
 * Acquire the one user-scoped TokenMonster runtime lease shared by the CLI
 * and Electron. The listening IPC object—not a PID file—is the authority.
 */
export async function acquireTokenMonsterRuntimeLease(
  options: AcquireTokenMonsterRuntimeLeaseOptions,
): Promise<TokenMonsterRuntimeLease> {
  const canonicalScopeDirectory = await prepareCanonicalScopeDirectory(
    options.scopeDirectory,
  );
  const identifier = tokenMonsterRuntimeLeaseIdentifier(
    canonicalScopeDirectory,
  );
  const platform = options.platform ?? process.platform;
  const endpoint = leaseEndpoint(
    identifier,
    platform,
    options.temporaryDirectory ?? tmpdir(),
  );
  const expectedProtocol = leaseProtocol(identifier);
  await preparePrivateSocketDirectory(endpoint.parentDirectory);

  for (let attempt = 0; attempt < MAX_ACQUISITION_ATTEMPTS; attempt += 1) {
    const sockets = new Set<Socket>();
    const server = createLeaseServer(sockets, expectedProtocol);
    let identity: SocketIdentity | null = null;
    try {
      await listen(server, endpoint.address);
      if (endpoint.filesystemPath !== null) {
        identity = await socketIdentity(endpoint.filesystemPath);
        await chmod(endpoint.filesystemPath, 0o600);
      }
      server.unref();
      let released: Promise<void> | null = null;
      return Object.freeze({
        release(): Promise<void> {
          released ??= (async () => {
            try {
              await closeServer(server, sockets);
              await removeOwnedSocketPath(endpoint.filesystemPath, identity);
            } catch (error) {
              if (error instanceof TokenMonsterRuntimeLeaseError) throw error;
              throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
            }
          })();
          return released;
        },
      });
    } catch (error) {
      for (const socket of sockets) socket.destroy();
      if (server.listening) {
        await closeServer(server, sockets).catch(() => undefined);
        await removeOwnedSocketPath(endpoint.filesystemPath, identity).catch(
          () => undefined,
        );
      }
      if (!hasCode(error, "EADDRINUSE")) {
        if (error instanceof TokenMonsterRuntimeLeaseError) throw error;
        throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
      }
      const probe = await probeLease(endpoint.address, expectedProtocol);
      if (probe === "active") {
        throw new TokenMonsterRuntimeLeaseError("already-running");
      }
      if (probe !== "stale") {
        throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
      }
      if (endpoint.filesystemPath !== null) {
        await recoverStaleFilesystemSocket(endpoint, expectedProtocol);
      }
    }
  }
  throw new TokenMonsterRuntimeLeaseError("lease-unavailable");
}
