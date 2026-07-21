import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import {
  QUOTA_CATALOG_FAMILIES,
  findQuotaPlan,
  isQuotaCatalogFamily,
  type QuotaCatalogFamily
} from "./quota-catalog.js";

export const QUOTA_PLANS_FILE = "quota-plans.json";

export interface QuotaPlanSelections {
  readonly schemaVersion: 1;
  readonly plans: Readonly<Partial<Record<QuotaCatalogFamily, string>>>;
}

function emptySelections(): QuotaPlanSelections {
  return Object.freeze({ schemaVersion: 1, plans: Object.freeze({}) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

export function parseQuotaPlanSelections(value: unknown): QuotaPlanSelections {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "plans"]) ||
    value["schemaVersion"] !== 1 ||
    !isRecord(value["plans"])
  ) {
    return emptySelections();
  }
  const plans: Partial<Record<QuotaCatalogFamily, string>> = {};
  for (const [family, planId] of Object.entries(value["plans"])) {
    if (
      isQuotaCatalogFamily(family) &&
      typeof planId === "string" &&
      findQuotaPlan(family, planId) !== undefined
    ) {
      plans[family] = planId;
    }
  }
  return Object.freeze({ schemaVersion: 1, plans: Object.freeze(plans) });
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function quotaPlansPath(progressionStorePath: string): string {
  return join(dirname(progressionStorePath), QUOTA_PLANS_FILE);
}

export async function loadQuotaPlanSelections(path: string): Promise<QuotaPlanSelections> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    const parsed = parseQuotaPlanSelections(raw);
    if (JSON.stringify(parsed) !== JSON.stringify(raw)) {
      await writeJsonAtomically(path, parsed);
    }
    return parsed;
  } catch (error) {
    const defaults = emptySelections();
    if (!isMissingFile(error)) await writeJsonAtomically(path, defaults);
    return defaults;
  }
}

export async function saveQuotaPlanSelections(
  path: string,
  selections: QuotaPlanSelections
): Promise<void> {
  await writeJsonAtomically(path, selections);
}

export function withQuotaPlanSelection(
  selections: QuotaPlanSelections,
  family: QuotaCatalogFamily,
  planId: string | null
): QuotaPlanSelections {
  const plans: Partial<Record<QuotaCatalogFamily, string>> = {};
  for (const candidate of QUOTA_CATALOG_FAMILIES) {
    const selected = selections.plans[candidate];
    if (selected !== undefined) plans[candidate] = selected;
  }
  if (planId === null) delete plans[family];
  else plans[family] = planId;
  return Object.freeze({ schemaVersion: 1, plans: Object.freeze(plans) });
}
