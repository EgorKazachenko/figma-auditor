#!/usr/bin/env node
// Thin launcher so the CLI can run without a build step.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(root, "node_modules", ".bin", "tsx");
const env = { ...process.env };
// Corporate gateways (Claude, Figma proxies) use certificates from the OS store. Node 23.8+ reads
// NODE_USE_SYSTEM_CA=1; Node 22 only has the --use-system-ca flag, so translate the variable.
if (env.NODE_USE_SYSTEM_CA === "1" && !/--use-system-ca/.test(env.NODE_OPTIONS ?? "")) {
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --use-system-ca`.trim();
}
const result = spawnSync(tsx, [join(root, "src", "cli.ts"), ...process.argv.slice(2)], { stdio: "inherit", env });
process.exit(result.status ?? 1);
