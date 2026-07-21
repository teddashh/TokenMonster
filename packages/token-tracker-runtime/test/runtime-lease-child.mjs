import {
  TokenMonsterRuntimeLeaseError,
  acquireTokenMonsterRuntimeLease,
} from "../src/single-runtime-lease.ts";

const [scopeDirectory, platform, temporaryDirectory] = process.argv.slice(2);
if (
  scopeDirectory === undefined ||
  platform === undefined ||
  temporaryDirectory === undefined
) {
  process.exit(2);
}

try {
  await acquireTokenMonsterRuntimeLease({
    scopeDirectory,
    platform,
    temporaryDirectory,
  });
  process.stdout.write("TOKENMONSTER_LEASE_READY\n");
  setInterval(() => undefined, 60_000);
} catch (error) {
  const code =
    error instanceof TokenMonsterRuntimeLeaseError ? error.code : "unexpected";
  process.stdout.write(`TOKENMONSTER_LEASE_ERROR:${code}\n`);
  process.exitCode = 1;
}
