"use strict";

// This module is preloaded before the exact-pinned TokenTracker CLI. The
// managed child only reads local usage and serves a loopback listener; it has
// no reason to initiate network traffic. Keep this guard dependency-free so
// the same bytes can be required by both plain Node and Electron's utility
// process shim.

const dgram = require("node:dgram");
const childProcess = require("node:child_process");
const dns = require("node:dns");
const http = require("node:http");
const http2 = require("node:http2");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const workerThreads = require("node:worker_threads");
const { syncBuiltinESMExports } = require("node:module");

const INSTALL_MARKER = Symbol.for("tokenmonster.sidecar.network-deny.v1");
const ERROR_CODE = "TOKENMONSTER_SIDECAR_EGRESS_BLOCKED";
const originalDnsLookup = dns.lookup;

/** @returns {Error & { code: string }} */
function blockedError() {
  const error = /** @type {Error & { code: string }} */ (
    new Error("TokenMonster blocked sidecar network egress.")
  );
  error.code = ERROR_CODE;
  return error;
}

function blocked() {
  throw blockedError();
}

function blockedPromise() {
  return Promise.reject(blockedError());
}

/**
 * @param {string} hostname
 * @param {...unknown} arguments_
 * @returns {unknown}
 */
function loopbackLookup(hostname, ...arguments_) {
  if (hostname !== "127.0.0.1" && hostname !== "::1") blocked();
  return Reflect.apply(originalDnsLookup, dns, [hostname, ...arguments_]);
}

/**
 * @param {object} target
 * @param {string | symbol} property
 * @param {Function} replacement
 */
function lockFunction(target, property, replacement) {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error(
      `TokenMonster network guard cannot secure ${String(property)}.`
    );
  }
  Object.defineProperty(target, property, {
    ...descriptor,
    configurable: false,
    writable: false,
    value: replacement
  });
}

/**
 * @param {object} target
 * @param {string | symbol} property
 * @param {Function} replacement
 */
function lockOptionalFunction(target, property, replacement) {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  if (descriptor === undefined) return;
  if (typeof descriptor.value !== "function") {
    throw new Error(
      `TokenMonster network guard cannot secure ${String(property)}.`
    );
  }
  Object.defineProperty(target, property, {
    ...descriptor,
    configurable: false,
    writable: false,
    value: replacement
  });
}

/**
 * Lock every current runtime function whose name matches the supplied pattern.
 * DNS grows new RR-specific `resolve*` methods over time, so a hand-maintained
 * method list would silently reopen egress when the exact Node patch changes.
 *
 * @param {object} target
 * @param {RegExp} pattern
 * @param {Function} replacement
 * @returns {readonly string[]}
 */
function lockMatchingFunctions(target, pattern, replacement) {
  const properties = Object.getOwnPropertyNames(target).filter((property) =>
    pattern.test(property)
  );
  if (!properties.includes("resolve")) {
    throw new Error("TokenMonster network guard found no DNS resolve API.");
  }
  for (const property of properties) {
    const descriptor = Object.getOwnPropertyDescriptor(target, property);
    if (descriptor === undefined || typeof descriptor.value !== "function") {
      throw new Error(
        `TokenMonster network guard cannot classify ${String(property)}.`
      );
    }
    lockFunction(target, property, replacement);
  }
  return Object.freeze(properties);
}

function install() {
  if (
    Object.getOwnPropertyDescriptor(globalThis, INSTALL_MARKER)?.value === true
  ) {
    return;
  }

  Object.defineProperty(globalThis, INSTALL_MARKER, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true
  });

  lockFunction(globalThis, "fetch", blockedPromise);
  lockOptionalFunction(globalThis, "WebSocket", blocked);

  for (const module of [http, https]) {
    lockFunction(module, "request", blocked);
    lockFunction(module, "get", blocked);
  }
  lockFunction(http2, "connect", blocked);

  lockFunction(net, "connect", blocked);
  lockFunction(net, "createConnection", blocked);
  lockFunction(net.Socket.prototype, "connect", blocked);
  lockFunction(tls, "connect", blocked);

  lockFunction(dgram, "createSocket", blocked);
  for (const property of ["connect", "send", "sendto"]) {
    lockFunction(dgram.Socket.prototype, property, blocked);
  }

  if (typeof process.versions["electron"] === "string") {
    let utility;
    try {
      // Keep this runtime-only specifier out of the plain-Node TypeScript
      // build graph. Electron exposes it only inside an Electron process.
      const utilitySpecifier = ["electron", "utility"].join("/");
      utility = require(utilitySpecifier);
    } catch {
      throw new Error(
        "TokenMonster network guard cannot secure the Electron utility network."
      );
    }
    if (
      typeof utility !== "object" ||
      utility === null ||
      typeof utility.net !== "object" ||
      utility.net === null
    ) {
      throw new Error(
        "TokenMonster network guard cannot secure the Electron utility network."
      );
    }
    lockFunction(utility.net, "fetch", blockedPromise);
    lockFunction(utility.net, "request", blocked);
    lockFunction(utility.net, "resolveHost", blockedPromise);
  }

  // The reviewed sidecar is a local parser/server, not a command launcher.
  // In particular its otherwise unauthenticated usage-limits route can spawn
  // provider CLIs whose native networking would bypass this Node preload.
  // Deny every public child-process entry point before sidecar modules load.
  for (const property of [
    "exec",
    "execFile",
    "execFileSync",
    "execSync",
    "fork",
    "spawn",
    "spawnSync"
  ]) {
    lockFunction(childProcess, property, blocked);
  }
  lockFunction(childProcess.ChildProcess.prototype, "spawn", blocked);
  lockFunction(workerThreads, "Worker", blocked);

  lockFunction(dns, "lookup", loopbackLookup);
  lockFunction(dns.promises, "lookup", blockedPromise);
  lockFunction(dns, "lookupService", blocked);
  lockFunction(dns.promises, "lookupService", blockedPromise);
  lockFunction(dns, "reverse", blocked);
  lockFunction(dns.promises, "reverse", blockedPromise);
  lockFunction(dns.Resolver.prototype, "reverse", blocked);
  lockFunction(dns.promises.Resolver.prototype, "reverse", blockedPromise);

  lockMatchingFunctions(dns, /^resolve/u, blocked);
  lockMatchingFunctions(dns.promises, /^resolve/u, blockedPromise);
  lockMatchingFunctions(dns.Resolver.prototype, /^resolve/u, blocked);
  lockMatchingFunctions(
    dns.promises.Resolver.prototype,
    /^resolve/u,
    blockedPromise
  );

  // Built-in ESM named exports are snapshots unless explicitly synchronized.
  // Update them after the CommonJS module objects have been locked.
  syncBuiltinESMExports();
}

install();

module.exports = Object.freeze({ ERROR_CODE, install });
