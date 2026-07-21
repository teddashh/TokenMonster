# Reviewed Squirrel.Windows updater candidate

This directory binds the exact updater used by TokenMonster's internal Windows
installer gate. It is the official Squirrel.Windows 2.0.1 source plus upstream
commit `c98244936f6876b080366417301268058028a53c`, which fixes Update.exe holding
its own executable open while trying to replace it.

The binary was rebuilt twice in one locked Actions job using isolated dependency
caches, then the artifact archive was downloaded and bound byte-for-byte.
`integration-review.json` binds the Actions run, artifact archive digest, source
identities, dependency/source-test/merge input receipts, and the final PE digest.
The maker never edits
`node_modules/electron-winstaller`; it verifies that package's complete vendor
inventory, copies it into a temporary overlay, and replaces only `Squirrel.exe`.
The normalized confirmation provenance and exact dependency/merge receipts are
retained under `provenance/`; the original Actions artifact archive digest stays
bound in `integration-review.json`.

`licenses/` preserves the exact Squirrel.Windows, pinned NuGet submodule, and
Microsoft.Web.Xdt license/copyright/credits/attribution texts from the
reproducible-build artifact.
`provenance/licenses/ILREPACK-LICENSE.txt` covers only the build tool. These are
not the still-pending complete merged-runtime notice bundle.

This is deliberately an internal candidate, not a public-release approval.
Public redistribution remains blocked until the complete merged third-party
notice bundle and terms are accepted, and the native signed install/start/
uninstall matrix passes.
