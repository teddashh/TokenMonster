# Complete merged-runtime notice bundle — reviewed Squirrel updater

This document is the complete third-party notice bundle for public
redistribution of the reviewed Squirrel updater binary
(`Squirrel.exe`, installed as `Update.exe`; SHA-256
`83b754a9b24742675678c5d8fa024a8140c2d18eb640116a87a364f0a897388a`,
1,841,664 bytes) and for the Windows Squirrel installer surface that
embeds it (`TokenMonsterSetup.exe`, `RELEASES`, and the full `.nupkg`).
Every component below permits binary redistribution with notice. The
exact per-module digests are bound in `../provenance/merge-input-hashes.txt`
and the exact upstream package digests in
`../provenance/nuget-content-hashes.txt`.

## Modules merged into the updater binary

| Merged module | Component (version) | License | Text in this directory |
| --- | --- | --- | --- |
| `Update.exe`, `Squirrel.dll` | Squirrel.Windows 2.0.1 + reviewed fix commit `c9824493` | MIT | `SQUIRREL-WINDOWS-LICENSE.txt` |
| `NuGet.Squirrel.dll` | Squirrel.Windows pinned NuGet submodule | Apache-2.0 | `NUGET-SUBMODULE-LICENSE.txt` (+ `-COPYRIGHT.txt`, `-CREDITS.txt`) |
| `Microsoft.Web.XmlTransform.dll` | Microsoft.Web.Xdt 3.1.0, rebuilt from `dotnet/xdt` source commit `5b67dee04d86740575f0f5022b79833213cc024a` | Apache-2.0 | `MICROSOFT-WEB-XDT-LICENSE.txt` (+ `-ATTRIBUTION.txt`) |
| `SharpCompress.dll` | SharpCompress 0.17.1 (Adam Hathcock) | MIT, with embedded third-party notices | `SHARPCOMPRESS-LICENSE.txt` + `SHARPCOMPRESS-THIRD-PARTY-NOTICES.txt` |
| `Mono.Cecil.dll` | Mono.Cecil 0.11.2 (Jb Evain; Novell, Inc.) | MIT | `MONO-CECIL-LICENSE.txt` |
| `DeltaCompressionDotNet.dll`, `DeltaCompressionDotNet.MsDelta.dll` | DeltaCompressionDotNet 1.1.0 (Todd Aspeotis) | MS-PL | `DELTACOMPRESSIONDOTNET-LICENSE.txt` |
| `WpfAnimatedGif.dll` | WpfAnimatedGif 1.4.15 (Thomas Levesque) | Apache-2.0 | `WPFANIMATEDGIF-LICENSE.txt` |

License-text provenance: SharpCompress and Mono.Cecil texts are the
`LICENSE.txt` blobs of the upstream repositories at tags `0.17.1` and
`0.11.2`. The DeltaCompressionDotNet text is the MS-PL `LICENSE` file of
`taspeotis/DeltaCompressionDotNet` (the 1.1.0 package ships no embedded
license file; its `.nuspec` names Todd Aspeotis and the project has been
MS-PL for its whole history). The WpfAnimatedGif 1.4.15 `.nuspec` points
`licenseUrl` at the canonical Apache-2.0 text, reproduced here. All four
upstream packages were re-downloaded from nuget.org and matched the
pinned SHA-512 digests in `../provenance/nuget-content-hashes.txt`
before their license texts were accepted.

## Installer-surface components outside the updater binary

- `Setup.exe` (bootstrapper written with the application archive) and
  `StubExecutable.exe` are unmodified Squirrel.Windows 2.0.1 release
  binaries (MIT, `SQUIRREL-WINDOWS-LICENSE.txt`) vendored by
  `electron-winstaller 5.4.4` (MIT, `ELECTRON-WINSTALLER-LICENSE.txt`);
  their exact digests are pinned in
  `../electron-winstaller-5.4.4-vendor-hashes.txt`.
- The packaged application inside the `.nupkg` ships Electron's own
  `LICENSE` and `LICENSES.chromium.html`, and the repository-level
  `THIRD_PARTY_NOTICES.md` covers the bundled npm runtime dependencies.
- `DeltaCompressionDotNet.MsDelta.dll` calls the Windows-provided
  `msdelta.dll` through P/Invoke; no Microsoft OS component is
  redistributed.
- The build-only merge tool is covered by
  `../provenance/licenses/ILREPACK-LICENSE.txt` and is not distributed.

This bundle must accompany every public distribution of the Windows
Squirrel installer artifacts.
