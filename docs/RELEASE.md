# Release packaging

`scripts/release/build-release.mjs` produces a single installable tarball from
the workspace without publishing any package to a registry.

```
node scripts/release/build-release.mjs [--version-suffix rc.1] [--out <dir>] [--skip-build]
```

What it does:

1. Builds every workspace package (`scripts/run-workspaces.mjs build`), unless
   `--skip-build` is passed.
2. Assembles `dist-release/staging/package/` — the CLI package's `dist/` plus a
   physical `node_modules/` containing the six `@tokenmonster/*` packages and
   `zod`. Each package is copied according to its own `files` allowlist.
3. Writes a transformed root `package.json`: `private` is dropped, the
   workspace packages and `zod` become `dependencies` + `bundleDependencies`,
   and `tokentracker-cli` stays an external registry dependency (the sidecar is
   resolved at runtime via `require.resolve`, so it must be a real install).
4. Creates `dist-release/tokenmonster-<version>.tgz` with `tar` (the staging
   directory is already named `package/`, which is the layout npm expects) and
   writes `SHASUMS256.txt`.

No image, audio, or other binary asset is inside the tarball — the embedded
asset manifest is JSON, and character assets download lazily from the CDN after
unlock, exactly as in development.

## Installing a release tarball

Use a directory-local install:

```
mkdir tokenmonster-app && cd tokenmonster-app
npm install /path/to/tokenmonster-<version>.tgz
npx tokenmonster
```

Requires Node.js >= 20. The install fetches exactly one package family from the
registry: `tokentracker-cli` (the sidecar) and its dependencies.

**Do not use `npm install -g` on the tarball.** npm has a global-install quirk
with bundled dependencies: transitive install scripts (the sidecar's
`@mongodb-js/zstd` needs `prebuild-install`) run without the nested
`node_modules/.bin` on `PATH` and the install fails. Directory-local installs
hoist correctly on every platform.

## Testing from a repo clone (all platforms, including Windows)

Prerequisite: Node 24.15.0 exactly — the workspace root pins exact engines
with `engine-strict`, so `npm ci` rejects any other version. PowerShell is
fine for every command below.

```
git clone <repo> && cd TokenMonster
npm ci
node scripts/release/build-release.mjs
mkdir tokenmonster-app && cd tokenmonster-app
npm install ../dist-release/tokenmonster-0.1.0.tgz
npx tokenmonster
```

Notes:

- Do NOT run a full workspace build on Windows (`npm run build` at the root);
  the Electron app's vite build currently fails there. The release script
  builds only the seven shipped packages (dependency-closure scoping in
  `run-workspaces.mjs`), which is Windows-clean and CI-verified.
- `node scripts/release/smoke-installed.mjs <install-dir>` runs the same
  automated smoke CI uses against the directory you installed into.
- On a machine with no real TokenTracker usage the dashboard is an honest
  empty state and every character stays locked. To exercise unlocks, wardrobe,
  and voice anyway, run `node scripts/qa/seed-demo-store.mjs` (after the
  release build) BEFORE the first launch — it writes a demo progression store
  and refuses to touch an existing one. Reset by deleting `~/.tokenmonster`.
- Every CI run also uploads ready-made, platform-verified tarballs as the
  `tokenmonster-release-<os>` artifacts if you want to skip building.
