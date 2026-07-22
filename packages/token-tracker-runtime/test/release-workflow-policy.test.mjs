import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const rootDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const workflow = await readFile(
  resolve(rootDirectory, ".github/workflows/ci.yml"),
  "utf8",
);
const squirrelExecutor = await readFile(
  resolve(
    rootDirectory,
    "scripts/release/windows-squirrel-feed-executor-policy.mjs",
  ),
  "utf8",
);
const squirrelAdapter = await readFile(
  resolve(rootDirectory, "scripts/release/promote-windows-squirrel-feed.mjs"),
  "utf8",
);

function occurrences(value, pattern) {
  return value.split(pattern).length - 1;
}

function job(name) {
  const startMarker = `\n  ${name}:\n`;
  const start = workflow.indexOf(startMarker);
  expect(start, `missing workflow job ${name}`).toBeGreaterThanOrEqual(0);
  const tail = workflow.slice(start + startMarker.length);
  const next = /\n  [a-z][a-z0-9-]+:\n/u.exec(tail);
  return workflow.slice(
    start,
    next === null ? undefined : start + startMarker.length + next.index,
  );
}

function step(jobText, name) {
  const startMarker = `\n      - name: ${name}\n`;
  const start = jobText.indexOf(startMarker);
  expect(start, `missing workflow step ${name}`).toBeGreaterThanOrEqual(0);
  const next = jobText.indexOf("\n      - name:", start + startMarker.length);
  return jobText.slice(start, next < 0 ? undefined : next);
}

describe("release workflow publication policy", () => {
  it("keeps the contribution player in the fresh-checkout sidecar path", () => {
    const compatibility = job("sidecar-compatibility");
    const checks = [
      ["Build sidecar path", "build"],
      ["Type-check sidecar path", "typecheck"],
      ["Test sidecar path without collection", "test"],
    ];
    const dependencyOrder = [
      "@tokenmonster/contracts",
      "@tokenmonster/monster-engine",
      "@tokenmonster/local-store",
      "@tokenmonster/token-tracker-adapter",
      "@tokenmonster/token-tracker-runtime",
      "@tokenmonster/contribution-runtime",
      "@tokenmonster/companion-gateway",
      "tokenmonster",
    ];
    for (const [stepName, command] of checks) {
      const check = step(compatibility, stepName);
      let priorIndex = -1;
      for (const workspace of dependencyOrder) {
        const marker = `npm ${command === "test" ? "test" : `run ${command}`} --workspace ${workspace}`;
        expect(occurrences(check, marker), `${stepName}: ${workspace}`).toBe(1);
        const index = check.indexOf(marker);
        expect(
          index,
          `${stepName}: ${workspace} dependency order`,
        ).toBeGreaterThan(priorIndex);
        priorIndex = index;
      }
    }
  });

  it("keeps public tag publication in a non-cancelling lane and retires internal prerelease lanes", () => {
    expect(workflow).toContain('tags:\n      - "v*"');
    expect(workflow).not.toContain('tags:\n      - "*"');
    expect(workflow).toContain(
      "github.ref_type == 'tag' && 'tokenmonster-public-tag-release'",
    );
    expect(workflow).toContain(
      "cancel-in-progress: >-\n    ${{ github.ref_type != 'tag' }}",
    );
    expect(workflow).not.toContain("publish_internal_rc15");
    expect(workflow).not.toContain("publish_internal_rc17");
    expect(workflow).not.toContain("publish-internal-prerelease");
    expect(workflow).not.toContain("internal-release-version");
    expect(workflow).not.toContain("INTERNAL_RELEASE_TAG");
    expect(workflow).not.toContain("INTERNAL_RELEASE_VERSION");
  });

  it("keeps every signed and public promotion job on push tags only", () => {
    for (const name of [
      "signed-windows-installer",
      "unsigned-windows-installer",
      "macos-internal-release-gate",
      "stage-companion-release",
      "publish-cli-npm",
      "promote-windows-release",
      "publish-companion-release",
    ]) {
      const configuration = job(name).slice(0, job(name).indexOf("    steps:"));
      expect(configuration, name).toContain(
        "if: github.event_name == 'push' && github.ref_type == 'tag'",
      );
      expect(configuration, name).not.toContain("publish_internal_rc17");
    }
  });

  it("derives every CLI candidate from the shared source-based authority", () => {
    const candidate = job("release-candidate");
    expect(candidate).toContain("node scripts/derive-cli-release-version.mjs");
    expect(candidate).not.toContain("-ci.${GITHUB_RUN_ID}");
    expect(candidate).not.toContain("derive-companion-release-version.mjs");
  });

  it("blocks on any audit finding across shipped and development dependencies", () => {
    const verification = job("verify");
    const shippedAudit = step(
      verification,
      "Audit shipped root dependencies",
    );
    const fullAudit = step(verification, "Audit complete dependency tree");
    const evidence = step(verification, "Generate release evidence");
    const upload = step(verification, "Upload immutable release evidence");

    expect(shippedAudit).toContain(
      "npm audit --omit=dev --audit-level=high",
    );
    expect(shippedAudit).not.toContain("set +e");
    expect(shippedAudit).not.toContain("|| true");

    expect(fullAudit).toContain("set -o pipefail");
    expect(fullAudit).toContain(
      "npm audit --json | tee release-evidence/npm-audit-full.json",
    );
    expect(fullAudit).not.toContain("set +e");
    expect(fullAudit).not.toContain("|| true");
    expect(fullAudit).not.toContain("audit-level");
    expect(workflow).not.toContain("verify-temporary-dev-audit-exception");
    expect(workflow).not.toContain("npm-audit-temporary-exception");

    expect(upload).toContain("release-evidence/");
    expect(verification.indexOf(shippedAudit)).toBeLessThan(
      verification.indexOf(fullAudit),
    );
    expect(verification.indexOf(fullAudit)).toBeLessThan(
      verification.indexOf(evidence),
    );
    expect(verification.indexOf(evidence)).toBeLessThan(
      verification.indexOf(upload),
    );
  });

  it("audits the exact verified tarball production lock before candidate upload", () => {
    const candidate = job("release-candidate");
    const build = step(candidate, "Build release artifact");
    const digest = step(candidate, "Verify candidate digest and inventory");
    const audit = step(candidate, "Audit exact shipped candidate dependencies");
    const upload = step(candidate, "Upload immutable candidate bytes");

    expect(audit).toContain("tarballs=(dist-release/tokenmonster-*.tgz)");
    expect(audit).toContain(
      'audit_root="$RUNNER_TEMP/tokenmonster-exact-candidate-audit"',
    );
    expect(audit).toContain('tar -xzf "${tarballs[0]}" -C "$audit_root"');
    expect(audit).toContain(
      'test -f "$audit_root/package/npm-shrinkwrap.json"',
    );
    expect(audit).toContain('cd "$audit_root/package"');
    expect(audit).toContain(
      "npm audit --package-lock-only --omit=dev --audit-level=high",
    );
    expect(audit).not.toContain("|| true");
    expect(audit).not.toContain("set +e");
    expect(candidate.indexOf(build)).toBeLessThan(candidate.indexOf(digest));
    expect(candidate.indexOf(digest)).toBeLessThan(candidate.indexOf(audit));
    expect(candidate.indexOf(audit)).toBeLessThan(candidate.indexOf(upload));
  });

  it("authenticates one all-platform zstd set before scripted installs", () => {
    const authentication = job("zstd-native-prebuilds");
    const audit = step(
      authentication,
      "Authenticate all pinned zstd prebuilds",
    );
    expect(audit).toContain("audit-zstd-native-prebuild.mjs");
    expect(audit).toContain("--all");
    expect(audit).toContain("--output authenticated-zstd-prebuilds");
    expect(authentication).toContain(
      "tokenmonster-zstd-native-prebuilds-${{ github.sha }}",
    );

    const consumers = [
      ["sidecar-compatibility", "Install exact dependencies"],
      ["companion-desktop", "Install exact dependencies"],
      ["companion-installers", "Install exact dependencies"],
      ["signed-windows-installer", "Install exact dependencies"],
      ["unsigned-windows-installer", "Install exact dependencies"],
      ["macos-internal-release-gate", "Install exact dependencies"],
      ["verify", "Install exact dependencies"],
      ["release-candidate", "Install exact dependencies"],
      ["promote-windows-release", "Install repo-pinned Wrangler"],
    ];
    for (const [name, installName] of consumers) {
      const consumer = job(name);
      const download = step(consumer, "Download authenticated zstd prebuilds");
      const install = step(consumer, installName);
      const jobConfiguration = consumer.slice(
        0,
        consumer.indexOf("    steps:"),
      );
      expect(consumer).toContain("zstd-native-prebuilds");
      expect(jobConfiguration).not.toContain("${{ runner.temp }}");
      expect(install).toContain("TOKENMONSTER_ZSTD_PREBUILD_DIR:");
      expect(install).toContain("npm_config_mongodb_js_zstd_local_prebuilds:");
      expect(download).toContain(
        "tokenmonster-zstd-native-prebuilds-${{ github.sha }}",
      );
      expect(consumer.indexOf(download)).toBeLessThan(
        consumer.indexOf(install),
      );
    }

    const candidate = job("release-candidate");
    expect(step(candidate, "Build release artifact")).toContain(
      '--zstd-prebuilds "$TOKENMONSTER_ZSTD_PREBUILD_DIR"',
    );
  });

  it("proves embedded zstd installation with no reusable cache or binary host", () => {
    const smokeJob = job("release-smoke");
    const install = step(smokeJob, "Install release tarball locally");
    const nativeVerification = step(
      smokeJob,
      "Verify installed zstd binding bytes",
    );
    const runtimeSmoke = step(smokeJob, "Smoke-test installed release");
    expect(install).toContain(
      "npm_config_mongodb_js_zstd_binary_host: http://127.0.0.1:1/",
    );
    expect(install).toContain("tokenmonster-empty-release-npm-cache");
    expect(install).toContain('if [[ -e "$smoke_cache" ]]');
    expect(install).toContain('npm_config_cache="$smoke_cache"');
    expect(install).not.toContain("mongodb_js_zstd_local_prebuilds");
    expect(install).not.toContain("set +e");
    expect(install).not.toContain("|| true");
    expect(smokeJob).not.toContain("Download authenticated zstd prebuilds");
    expect(nativeVerification).toContain("zstd-native-verifier.mjs");
    expect(nativeVerification).toContain("--installed-root");
    expect(smokeJob.indexOf(install)).toBeLessThan(
      smokeJob.indexOf(nativeVerification),
    );
    expect(smokeJob.indexOf(nativeVerification)).toBeLessThan(
      smokeJob.indexOf(runtimeSmoke),
    );
  });

  it("boots the exact tag-bound Linux package before release staging", () => {
    const verification = job("verify");
    const userNamespaceSetup = step(
      verification,
      "Enable bubblewrap user namespaces",
    );
    const make = step(verification, "Package and inspect unsigned companion");
    const smoke = step(verification, "Smoke exact tag-bound packaged app");
    expect(verification.indexOf(userNamespaceSetup)).toBeLessThan(
      verification.indexOf(make),
    );
    expect(verification.indexOf(make)).toBeLessThan(
      verification.indexOf(smoke),
    );
    expect(smoke).toContain("if: github.ref_type == 'tag'");
    expect(smoke).toContain('TOKENMONSTER_SMOKE: "1"');
    expect(smoke).toContain("timeout 180 xvfb-run --auto-servernum");
    expect(smoke).toContain(
      "apps/companion/out/TokenMonster-linux-x64/TokenMonster",
    );
    expect(smoke).toContain("--tokenmonster-smoke");
    expect(smoke).toContain('[[ "$smoke_status" -ne 0 ]]');
    expect(smoke).toContain('grep -Fxq "TOKENMONSTER_SMOKE_OK" "$smoke_log"');
    expect(smoke).not.toContain("sysctl");
    expect(smoke).not.toContain("--no-sandbox");
    expect(smoke).not.toContain("|| true");
    expect(userNamespaceSetup).toContain(
      "kernel.apparmor_restrict_unprivileged_userns=0",
    );
    expect(
      step(verification, "Install denied-egress smoke-test tools"),
    ).toContain("xvfb");

    const installers = job("companion-installers");
    expect(installers).toContain("if: github.ref_type != 'tag'");
    const nonTagSmoke = step(installers, "Smoke packaged app");
    expect(nonTagSmoke).toContain('[[ "$smoke_status" -ne 0 ]]');
    expect(nonTagSmoke).toContain(
      'grep -Fxq "TOKENMONSTER_SMOKE_OK" smoke-packaged.log',
    );
    expect(nonTagSmoke).not.toContain("|| true");

    expect(job("stage-companion-release")).toContain("      - verify\n");
  });

  it("plans and verifies npm dist-tag publication around one credentialed mutation", () => {
    const npmJob = job("publish-cli-npm");
    expect(npmJob).toContain("plan-npm-publication.mjs");
    expect(npmJob).toContain("verify-npm-publication.mjs");
    expect(npmJob).toContain(
      'npm dist-tag add "tokenmonster@${RELEASE_VERSION}"',
    );
    expect(npmJob).toContain(
      "npx --yes --prefer-online tokenmonster --version",
    );
    expect(npmJob).toContain("--package tokenmonster@next");
    const publicSmoke = step(
      npmJob,
      "Smoke the exact and public-channel npx deliverables",
    );
    expect(publicSmoke).toContain('expected_cli_version="v${RELEASE_VERSION}"');
    expect(occurrences(publicSmoke, '!= "$expected_cli_version"')).toBe(2);
    expect(publicSmoke).not.toContain('!= "$RELEASE_VERSION"');
    expect(occurrences(npmJob, "TOKENMONSTER_NPM_TOKEN")).toBe(2);
    expect(step(npmJob, "Plan a monotonic npm publication")).not.toContain(
      "TOKENMONSTER_NPM_TOKEN",
    );
    expect(
      step(
        npmJob,
        "Verify authoritative npm bytes and dist-tags after publication",
      ),
    ).not.toContain("TOKENMONSTER_NPM_TOKEN");
  });

  it("uses authoritative R2 reads before and after the protected single-writer put", () => {
    const promotion = job("promote-windows-release");
    const r2Step = step(
      promotion,
      "Authoritatively create or verify the immutable R2 object",
    );
    const bucketInfo = r2Step.indexOf("wrangler r2 bucket info");
    const firstGet = r2Step.indexOf("wrangler r2 object get");
    const put = r2Step.indexOf("wrangler r2 object put");
    const secondGet = r2Step.indexOf("wrangler r2 object get", firstGet + 1);
    expect(bucketInfo).toBeGreaterThanOrEqual(0);
    expect(firstGet).toBeGreaterThan(bucketInfo);
    expect(put).toBeGreaterThan(firstGet);
    expect(secondGet).toBeGreaterThan(put);
    expect(r2Step).toContain('wrangler_version" != "4.111.0"');
    expect(r2Step).toContain("classify-wrangler-r2-get.mjs");
    expect(r2Step).not.toContain('probe_status" == "404"');
    expect(promotion).toContain(
      "Wrangler has no atomic create-only R2 operation",
    );
    expect(promotion).toContain("one global,");
  });

  it("verifies the complete Squirrel candidate before any credentialed mutation", () => {
    const promotion = job("promote-windows-release");
    const generation = step(
      promotion,
      "Generate the exact installer binding and Squirrel candidate",
    );
    const verification = step(
      promotion,
      "Verify the deterministic Squirrel feed candidate",
    );
    const mutation = step(
      promotion,
      "Authoritatively create or verify the immutable R2 object",
    );
    expect(generation).toContain("prepare-windows-promotion.mjs");
    expect(verification).toContain("verify-windows-squirrel-candidate.mjs");
    expect(verification).toContain(
      "windows-squirrel-candidate-verification-v1.json",
    );
    expect(promotion.indexOf(verification)).toBeLessThan(
      promotion.indexOf(mutation),
    );
    expect(promotion.indexOf(verification)).toBeLessThan(
      promotion.indexOf(
        step(promotion, "Promote and verify the exact Squirrel feed"),
      ),
    );
    expect(generation).not.toContain(
      "TOKENMONSTER_CLOUDFLARE_RELEASE_API_TOKEN",
    );
    expect(verification).not.toContain(
      "TOKENMONSTER_CLOUDFLARE_RELEASE_API_TOKEN",
    );
    expect(verification).not.toContain("wrangler r2 object put");
    expect(verification).not.toContain("curl ");
    expect(promotion).not.toContain(
      "plan-windows-squirrel-promotion.mjs --missing",
    );
    const evidence = step(promotion, "Preserve promotion evidence");
    expect(evidence).toContain("windows-squirrel-candidate-v1.json");
    expect(evidence).toContain(
      "windows-squirrel-candidate-verification-v1.json",
    );
    expect(evidence).toContain("windows-squirrel-promotion-evidence-v1.json");
  });

  it("keeps Cloudflare credentials out of setup and scopes them to mutations", () => {
    const promotion = job("promote-windows-release");
    const secret = "secrets.TOKENMONSTER_CLOUDFLARE_RELEASE_API_TOKEN";
    expect(occurrences(promotion, secret)).toBe(3);
    expect(step(promotion, "Check out release promotion code")).not.toContain(
      secret,
    );
    expect(step(promotion, "Set up exact release Node.js")).not.toContain(
      secret,
    );
    expect(step(promotion, "Install repo-pinned Wrangler")).not.toContain(
      secret,
    );
    expect(
      step(
        promotion,
        "Authoritatively create or verify the immutable R2 object",
      ),
    ).toContain(secret);
    expect(
      step(promotion, "Promote and verify the exact Squirrel feed"),
    ).toContain(secret);
    expect(
      step(promotion, "Promote only a monotonic generated Worker binding"),
    ).toContain(secret);
  });

  it("executes a fail-closed, cache-explicit Squirrel channel transaction", () => {
    const promotion = job("promote-windows-release");
    const mutation = step(
      promotion,
      "Promote and verify the exact Squirrel feed",
    );
    expect(mutation).toContain("promote-windows-squirrel-feed.mjs");
    expect(mutation).toContain("windows-squirrel-promotion-evidence-v1.json");
    expect(promotion).toContain(
      "non-cancelling tag concurrency group is the single",
    );
    expect(promotion).toContain("timeout-minutes: 90");
    expect(squirrelExecutor).toContain(
      "retrieveAuthoritativeWindowsSquirrelChannel",
    );
    expect(squirrelExecutor).toContain(
      "public channel full-package before metadata commit",
    );
    expect(
      squirrelExecutor.indexOf('label: "channel full-package"'),
    ).toBeLessThan(
      squirrelExecutor.indexOf(
        'operations.push("channel-releases-commit-attempt-returned")',
      ),
    );
    expect(squirrelExecutor).toContain(
      "public first-publication RELEASES rollback",
    );
    expect(squirrelExecutor).toContain(
      "prior-channel-full-package-retained-for-client-overlap",
    );
    expect(squirrelExecutor).not.toContain(
      "prior-channel-full-package-retired",
    );
    expect(squirrelAdapter).toContain("COMMAND_TIMEOUT_MS = 180_000");
    expect(squirrelAdapter).toContain("EXECUTOR_DEADLINE_MS = 60 * 60 * 1_000");
    expect(squirrelAdapter).toContain(
      "METADATA_CRITICAL_WINDOW_MS = 30 * 60 * 1_000",
    );
    expect(squirrelAdapter).toContain('child.kill("SIGKILL")');
    expect(squirrelAdapter).toContain("process.execPath");
    expect(squirrelAdapter).toContain(
      '"node_modules/wrangler/bin/wrangler.js"',
    );
    expect(squirrelAdapter).not.toContain("stdout.includes(WRANGLER_VERSION)");
    expect(squirrelExecutor).toContain(
      "insufficient aggregate deadline remains for Squirrel metadata commit",
    );
    expect(squirrelAdapter).toContain('"--cache-control"');
    expect(squirrelAdapter).toContain('cache: "no-store"');
  });

  it("guards the Worker binding with monotonic planning and exact readback", () => {
    const promotion = job("promote-windows-release");
    const plan = promotion.indexOf("plan-worker-publication.mjs");
    const mutation = promotion.indexOf(
      "wrangler secret put TOKENMONSTER_PUBLIC_RELEASE_JSON",
    );
    const readback = promotion.indexOf(
      "Read back the exact public Worker binding",
    );
    expect(plan).toBeGreaterThanOrEqual(0);
    expect(mutation).toBeGreaterThan(plan);
    expect(readback).toBeGreaterThan(mutation);
    expect(promotion).toContain(
      "if: steps.plan-worker.outputs.decision == 'advance'",
    );
    expect(promotion).toContain('{"error":"PUBLIC_RELEASE_NOT_CONFIGURED"}');
  });

  it("revalidates GitHub tag and prerelease metadata before and after publish", () => {
    const publication = job("publish-companion-release");
    expect(publication).toContain("--json isDraft,isPrerelease,assets,tagName");
    expect(publication).toContain("--json isDraft,isPrerelease,tagName");
    expect(publication).toContain("published_json=");
    expect(publication).toContain(".isDraft");
    expect(occurrences(publication, ".isPrerelease")).toBeGreaterThanOrEqual(2);
    expect(occurrences(publication, ".tagName")).toBeGreaterThanOrEqual(2);
  });
});
