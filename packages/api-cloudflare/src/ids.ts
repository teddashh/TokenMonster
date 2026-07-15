import type {
  OpaqueIdGenerator,
  OpaqueIdKind
} from "@tokenmonster/api-domain";

import { resolveWebCrypto, type WebCryptoPort } from "./config.js";
import { encodeBase64Url } from "./encoding.js";
import {
  CloudflareAdapterError,
  sanitizeCryptoFailure
} from "./errors.js";

const PREFIX_BY_KIND: Readonly<Record<OpaqueIdKind, string>> = Object.freeze({
  installation: "ins_",
  "consent-event": "cr_",
  "deletion-job": "del_"
});

export class CloudflareOpaqueIdGenerator implements OpaqueIdGenerator {
  readonly #crypto: WebCryptoPort;

  constructor(crypto?: WebCryptoPort) {
    this.#crypto = resolveWebCrypto(crypto);
    Object.freeze(this);
  }

  generate(kind: OpaqueIdKind): string {
    if (
      kind !== "installation" &&
      kind !== "consent-event" &&
      kind !== "deletion-job"
    ) {
      throw new CloudflareAdapterError("INPUT_INVALID");
    }
    const bytes = new Uint8Array(16);
    try {
      this.#crypto.getRandomValues(bytes);
      return `${PREFIX_BY_KIND[kind]}${encodeBase64Url(bytes)}`;
    } catch (error: unknown) {
      sanitizeCryptoFailure(error);
    } finally {
      bytes.fill(0);
    }
  }

  toJSON(): Readonly<{ name: "CloudflareOpaqueIdGenerator" }> {
    return Object.freeze({ name: "CloudflareOpaqueIdGenerator" });
  }
}
