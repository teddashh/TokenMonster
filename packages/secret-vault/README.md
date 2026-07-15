# @tokenmonster/secret-vault

This Node/main-process package stores one opaque secret in memory and, only
when an approved OS-backed Electron safeStorage backend is available, in a
separate encrypted file. It never writes plaintext, logs values, touches the
local SQLite database, or includes the ciphertext in diagnostics/exports.

macOS and Windows may persist after asynchronous OS encryption is available.
Linux persistence is fail-closed unless the backend is `gnome_libsecret`,
`kwallet`, `kwallet5`, or `kwallet6`. `basic_text`, `unknown`, missing
encryption, and unsupported platforms stay RAM-only and remove any newly
requested persistent value from disk.

Encrypted documents are strict, bounded JSON containing only a schema version
and base64 ciphertext. Writes use a `0600` temporary file, fsync, atomic rename,
and a `0700` containing directory. Symlinks, non-regular files, oversized files,
malformed documents, and decrypt failures fail with stable sanitized errors.
