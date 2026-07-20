import { access, open, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const [lockPath, readyPath, goPath] = process.argv.slice(2);
if (
  [lockPath, readyPath, goPath].some(
    (value) => typeof value !== "string" || value.length === 0,
  )
) {
  throw new Error("invalid legacy lock-writer child arguments");
}

const handle = await open(lockPath, "wx", 0o600);
try {
  await writeFile(readyPath, "ready\n", { flag: "wx", mode: 0o600 });
  let released = false;
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    try {
      await access(goPath);
      released = true;
      break;
    } catch {
      await delay(5);
    }
  }
  if (!released) throw new Error("legacy lock-writer child barrier timed out");

  const owner = `${JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ownerId: "paused-rc7-writer",
  })}\n`;
  await handle.writeFile(owner, "utf8");
  await handle.sync();
  if ((await readFile(lockPath, "utf8")) !== owner) {
    throw new Error("legacy lock path was replaced while its writer was live");
  }
  process.stdout.write("owner-visible\n");
} finally {
  await handle.close().catch(() => undefined);
  await rm(lockPath, { force: true }).catch(() => undefined);
}
