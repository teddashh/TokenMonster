# `@tokenmonster/api-cloudflare`

Cloudflare Workers-compatible Web Crypto adapters for the pure
`@tokenmonster/api-domain` ports. This package intentionally contains no D1
storage, Hono routes, Node runtime imports, or provider credentials.

The credential service emits V1 upload, deletion, and deletion-status bearer
tokens. A stored credential contains only its scope, random public lookup ID,
scope-separated HMAC-SHA-256 verifier, and verifier key ID; raw bearer secrets and server keys
are never part of the storage artifact. New upload/deletion credentials use the
current pepper while verification accepts the configured current and previous
pepper during a reviewed rotation window. Deletion-status tokens are
deterministically derived from a separate key and deletion job ID so an
idempotent replay produces the same one-time response.

The transient issued-credential object exposes its bearer only through the
typed property used by the domain service. The property is non-enumerable and
the object's JSON form omits it, reducing accidental logging; the domain layer
must explicitly copy the value into the documented one-time enrollment or
deletion response.

All key inputs are canonical unpadded base64url encodings of exactly 32 bytes.
Factories reject unknown configuration fields, duplicate key IDs, and reused
key material across purposes. Imported `CryptoKey` values are non-extractable;
adapter instances serialize only a fixed type label and never retain the
serialized configuration object. Callers must source the serialized inputs
from separate Worker secret bindings and must never log those bindings.

Rate-limit keys use three independent HMAC keys for enrollment edge input,
ingest bearer input, and deletion bearer input. Only the derived keys may enter
rate-limit storage or domain commands; raw IP values and bearer tokens must not
be stored or logged.
