#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_TRACE_BYTES = 32 * 1024 * 1024;
const MAX_TRACE_LINE_CHARACTERS = 8 * 1024;

function fail(message) {
  throw new Error(`Installed release network trace rejected: ${message}`);
}

function isLoopbackIpv4(address) {
  const octets = address.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet)) &&
    octets.every((octet) => Number(octet) <= 255) &&
    octets[0] === "127"
  );
}

function isLoopbackIpv6(address) {
  return address.toLowerCase() === "::1";
}

function inspectSocketCreation(line, lineNumber) {
  if (!/\bsocket\(/u.test(line)) return;
  const match = line.match(
    /\bsocket\((AF_[A-Z0-9_]+), ([A-Z0-9_|]+), ([A-Z0-9_]+|0)\)/u,
  );
  if (match === null) {
    fail(`line ${lineNumber} opens an uninspectable socket`);
  }
  const [, family, rawType, protocol] = match;
  const typeParts = rawType?.split("|") ?? [];
  const socketType = typeParts.shift();
  const flags = new Set(typeParts);
  if (
    flags.size !== typeParts.length ||
    [...flags].some(
      (flag) => flag !== "SOCK_CLOEXEC" && flag !== "SOCK_NONBLOCK",
    )
  ) {
    fail(`line ${lineNumber} opens a socket with unreviewed flags`);
  }

  if (family === "AF_UNIX") {
    if (
      !new Set(["SOCK_STREAM", "SOCK_DGRAM", "SOCK_SEQPACKET"]).has(
        socketType,
      ) ||
      protocol !== "0"
    ) {
      fail(`line ${lineNumber} opens an unreviewed Unix socket shape`);
    }
    return;
  }

  if (family !== "AF_INET" && family !== "AF_INET6") {
    fail(`line ${lineNumber} opens an unreviewed network family`);
  }
  if (socketType !== "SOCK_STREAM" && socketType !== "SOCK_DGRAM") {
    fail(`line ${lineNumber} opens an unreviewed Internet socket type`);
  }
  const allowedProtocols =
    socketType === "SOCK_STREAM"
      ? new Set(["0", "IPPROTO_IP", "IPPROTO_TCP"])
      : new Set(["0", "IPPROTO_IP", "IPPROTO_UDP"]);
  if (protocol === undefined || !allowedProtocols.has(protocol)) {
    fail(`line ${lineNumber} opens an unreviewed Internet protocol`);
  }
}

export function inspectLoopbackNetworkTrace(trace) {
  if (typeof trace !== "string" || trace.length === 0 || trace.includes("\0")) {
    fail("trace is empty or malformed");
  }

  let loopbackBinds = 0;
  let loopbackConnects = 0;
  const lines = trace.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.length > MAX_TRACE_LINE_CHARACTERS) {
      fail(`line ${index + 1} exceeds the bounded strace format`);
    }
    inspectSocketCreation(line, index + 1);
    if (/\bsend\(/u.test(line)) {
      fail(`line ${index + 1} sends without an inspectable destination`);
    }
    if (
      /\b(?:sendto|sendmsg|sendmmsg)\(/u.test(line) &&
      !line.includes("sa_family=AF_UNIX") &&
      !line.includes("sa_family=AF_INET")
    ) {
      fail(`line ${index + 1} sends without an inspectable destination`);
    }
    if (
      /\b(?:bind|connect)\(/u.test(line) &&
      !line.includes("sa_family=AF_UNIX") &&
      !line.includes("sa_family=AF_INET")
    ) {
      fail(`line ${index + 1} uses an uninspectable socket address`);
    }

    if (line.includes("sa_family=AF_INET6")) {
      const addresses = [
        ...line.matchAll(/inet_pton\(AF_INET6, "([^"]+)"/gu),
      ].map((match) => match[1]);
      if (
        addresses.length === 0 ||
        addresses.some(
          (address) => address === undefined || !isLoopbackIpv6(address),
        )
      ) {
        fail(`line ${index + 1} contains a non-loopback IPv6 destination`);
      }
      if (line.includes(" bind(")) loopbackBinds += 1;
      if (line.includes(" connect(")) loopbackConnects += 1;
      continue;
    }

    if (line.includes("sa_family=AF_INET")) {
      const addresses = [...line.matchAll(/inet_addr\("([^"]+)"\)/gu)].map(
        (match) => match[1],
      );
      if (
        addresses.length === 0 ||
        addresses.some(
          (address) => address === undefined || !isLoopbackIpv4(address),
        )
      ) {
        fail(`line ${index + 1} contains a non-loopback IPv4 destination`);
      }
      if (line.includes(" bind(")) loopbackBinds += 1;
      if (line.includes(" connect(")) loopbackConnects += 1;
    }
  }

  if (loopbackBinds < 2) {
    fail("did not observe both sidecar and gateway loopback listeners");
  }
  if (loopbackConnects < 1) {
    fail("did not observe the managed loopback readiness connection");
  }
  return Object.freeze({ loopbackBinds, loopbackConnects });
}

async function main() {
  const argument = process.argv[2];
  if (argument === undefined || process.argv.length !== 3) {
    throw new Error(
      "Usage: node scripts/release/assert-loopback-network-trace.mjs <strace-log>",
    );
  }
  const path = resolve(argument);
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size < 1 ||
    metadata.size > MAX_TRACE_BYTES
  ) {
    fail("trace must be a bounded regular non-symlink file");
  }
  const result = inspectLoopbackNetworkTrace(await readFile(path, "utf8"));
  process.stdout.write(
    `Verified installed release network trace: ${result.loopbackBinds} loopback binds, ${result.loopbackConnects} loopback connects, no external destination.\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Trace verification failed");
    process.exitCode = 1;
  });
}
