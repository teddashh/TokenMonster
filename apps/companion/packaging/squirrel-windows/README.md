# Reviewed Squirrel.Windows updater candidate

This directory binds the exact updater used by TokenMonster's internal Windows
installer gate. It is the official Squirrel.Windows 2.0.1 source plus upstream
commit `c98244936f6876b080366417301268058028a53c`, which fixes Update.exe holding
its own executable open while trying to replace it.

The binary was rebuilt twice in one locked Actions job using isolated dependency
caches, then the artifact archive was downloaded and bound byte-for-byte.
`integration-review.json` binds the Actions run, artifact archive digest, source
identities, dependency/source-test/merge input receipts, and the final PE digest.
The reviewed `Squirrel.exe` binary itself is not tracked in this repository;
restore a binary matching that receipt to this directory before running the
internal Windows maker. CI restores it by re-running the locked reproducible
rebuild workflow and verifying the artifact digest; a local maker run can use
any byte-identical copy. The maker never edits
`node_modules/electron-winstaller`; it verifies that package's complete vendor
inventory, copies it into a temporary overlay, and replaces only `Squirrel.exe`.
The normalized confirmation provenance and exact dependency/merge receipts are
retained under `provenance/`; the original Actions artifact archive digest stays
bound in `integration-review.json`.

`licenses/` preserves the exact Squirrel.Windows, pinned NuGet submodule, and
Microsoft.Web.Xdt license/copyright/credits/attribution texts from the
reproducible-build artifact, plus the SharpCompress, Mono.Cecil,
DeltaCompressionDotNet, WpfAnimatedGif, and electron-winstaller texts verified
against the pinned upstream package digests.
`licenses/MERGED-RUNTIME-NOTICES.md` is the complete merged-runtime notice
bundle; `provenance/licenses/ILREPACK-LICENSE.txt` covers only the build tool.

Public release status: `approved-unsigned-public-test-pending-signing`. The
complete notice bundle accompanies every public distribution of the Windows
Squirrel installer artifacts, and the unsigned installer lane runs the native
clean-install/start/uninstall smoke on every published candidate.
Authenticode-signed distribution stays closed until audited signing
credentials exist and the signed install review passes; `releaseMode`
`"signed"` keeps failing closed until then.
