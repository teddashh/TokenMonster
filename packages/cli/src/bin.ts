#!/usr/bin/env node

import { runTokenMonster } from "./cli.js";

try {
  process.exitCode = await runTokenMonster({
    argv: process.argv.slice(2)
  });
} catch {
  process.stderr.write("TokenMonster 發生未預期的啟動錯誤。\n");
  process.exitCode = 1;
}
