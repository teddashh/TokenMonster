# Reviewed Squirrel.Windows updater candidate

This directory binds the exact updater used by TokenMonster's internal Windows
installer gate. It is the official Squirrel.Windows 2.0.1 source plus upstream
commit `c98244936f6876b080366417301268058028a53c`, which fixes Update.exe holding
its own executable open while trying to replace it.

The binary was rebuilt twice in isolated dependency caches, then independently
downloaded and compared byte-for-byte. `integration-review.json` binds both
Actions runs, artifact archive digests, source identities, dependency and merge
input receipts, and the final PE digest. The maker never edits
`node_modules/electron-winstaller`; it verifies that package's complete vendor
inventory, copies it into a temporary overlay, and replaces only `Squirrel.exe`.
The normalized confirmation provenance and exact dependency/merge receipts are
retained under `provenance/`; the original Actions artifact archive digest stays
bound in `integration-review.json`.

`licenses/` preserves the exact Squirrel.Windows and pinned NuGet submodule
license/copyright/credits texts from the reproducible-build artifact.
`provenance/licenses/ILREPACK-LICENSE.txt` covers only the build tool. These are
not the still-pending complete merged-runtime notice bundle.

This is deliberately an internal candidate, not a public-release approval.
Public redistribution remains blocked until all merged third-party notices and
terms are accepted, the Microsoft.Web.Xdt redistribution question is resolved,
and the native signed install/start/uninstall matrix passes.
