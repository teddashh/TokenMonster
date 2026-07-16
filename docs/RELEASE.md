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
