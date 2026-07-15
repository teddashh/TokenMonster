import { chmod, lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const COLLECTOR_COMPONENTS = ["collector", "tokscale"] as const;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

async function trustedDirectory(path: string, requirePrivateMode: boolean): Promise<boolean> {
  try {
    const status = await lstat(path);
    if (!status.isDirectory() || status.isSymbolicLink()) return false;
    if (process.platform !== "win32") {
      if (
        typeof process.getuid === "function" &&
        status.uid !== process.getuid()
      ) {
        return false;
      }
      if (requirePrivateMode) {
        if ((status.mode & 0o077) !== 0) return false;
      } else if ((status.mode & 0o022) !== 0) {
        // A group/world-writable parent can replace a 0700 child by name.
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function expectedTarget(
  root: string,
  components: readonly string[]
): string | null {
  if (
    typeof root !== "string" ||
    !isAbsolute(root) ||
    root.includes("\0") ||
    components.length === 0 ||
    components.some(
      (component) =>
        !SAFE_COMPONENT.test(component) || component === "." || component === ".."
    )
  ) {
    return null;
  }
  return resolve(root, ...components);
}

export async function ensurePrivateChildDirectory(
  root: string,
  components: readonly string[]
): Promise<string | null> {
  const target = expectedTarget(root, components);
  if (target === null || !(await trustedDirectory(root, false))) return null;
  let current = resolve(root);
  for (const component of components) {
    current = join(current, component);
    try {
      // Non-recursive creation is intentional: every parent is checked before
      // the next component is touched, so an intermediate symlink is rejected.
      await mkdir(current, { mode: 0o700 });
    } catch (error: unknown) {
      if (
        typeof error !== "object" ||
        error === null ||
        (error as { code?: unknown }).code !== "EEXIST"
      ) {
        return null;
      }
    }
    if (!(await trustedDirectory(current, false))) return null;
    try {
      await chmod(current, 0o700);
    } catch {
      return null;
    }
    if (!(await trustedDirectory(current, true))) return null;
  }
  return current === target ? current : null;
}

export async function verifyPrivateChildDirectory(
  root: string,
  target: string,
  components: readonly string[]
): Promise<boolean> {
  const expected = expectedTarget(root, components);
  if (expected === null || resolve(target) !== expected) return false;
  if (!(await trustedDirectory(root, false))) return false;
  let current = resolve(root);
  for (const component of components) {
    current = join(current, component);
    if (!(await trustedDirectory(current, true))) return false;
  }
  return current === expected;
}

export async function ensurePrivateCollectorDirectory(
  root: string
): Promise<string | null> {
  return ensurePrivateChildDirectory(root, COLLECTOR_COMPONENTS);
}

export async function verifyPrivateCollectorDirectory(
  root: string,
  target: string
): Promise<boolean> {
  return verifyPrivateChildDirectory(root, target, COLLECTOR_COMPONENTS);
}
