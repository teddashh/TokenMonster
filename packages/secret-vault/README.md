# @tokenmonster/secret-vault

This Node/main-process package stores one opaque secret in memory and, only
when an approved OS-backed Electron safeStorage backend is available, in a
separate encrypted file. It never writes plaintext, logs values, touches the
local SQLite database, or includes the ciphertext in diagnostics/exports.

macOS and Windows may persist after asynchronous OS encryption is available.
Linux persistence is fail-closed unless the backend is `gnome_libsecret`,
`kwallet`, `kwallet5`, or `kwallet6`. `basic_text`, `unknown`, missing
encryption, and unsupported platforms stay RAM-only. A temporary backend probe
failure never deletes an existing ciphertext or claims that it was loaded. A
RAM fallback also preserves that ciphertext; only an explicit `persist: false`
replacement or `clear()` removes the prior persisted authority.

Status reports persistence capability separately from active storage:
`persistence` says whether the host can use an approved OS backend, while the
required `activePersistence` field says where the currently configured value
lives. An explicit `persist: false` choice therefore remains `memory-only`
across local gateway/sidecar restart while that in-memory slot remains alive,
even on an OS-backed host. `createMemorySecretSlot()` provides the same bounded
validation and idempotent clear contract without disk I/O.

Encrypted documents are strict, bounded JSON containing only a schema version
and base64 ciphertext. Writes use a `0600` temporary file, fsync, atomic rename,
and a `0700` containing directory. The parent directory is fsynced after rename
and deletion where the host supports directory fsync. A real directory-fsync
failure restores the prior bounded ciphertext before reporting failure.
`EINVAL`, `ENOTSUP`/`EOPNOTSUPP`, and `ENOSYS` are treated as an unavailable
filesystem capability; Windows also permits its directory-specific `EISDIR`
and `EPERM` fallback. Permission and I/O errors outside that exact policy fail
the operation.
Persistent replacement and clear operations update their in-memory state only
after the filesystem commit succeeds; a failure preserves the prior disk
authority, while a failed persistent replacement may conservatively clear RAM.
Initialize, set, and clear accept abort signals. Cancellation is honored before
and throughout the atomic rename or unlink durability fence. An abort observed
during the parent-directory sync restores the prior disk authority before the
per-path queue advances, and RAM/status are not published after a late abort.
Symlinks, non-regular files, oversized files, malformed documents, and decrypt
failures use stable sanitized errors.
