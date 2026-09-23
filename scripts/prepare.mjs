import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

if (!existsSync(tsc)) {
  // A global install from a Git URL can run prepare without first placing the
  // repository's devDependencies in its temporary clone. Install them locally
  // without recursively invoking lifecycle scripts.
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = npmExecPath
    ? [npmExecPath, "install", "--global=false", "--ignore-scripts", "--include=dev", "--no-save", "--no-audit", "--no-fund"]
    : ["install", "--global=false", "--ignore-scripts", "--include=dev", "--no-save", "--no-audit", "--no-fund"];

  run(command, args);
}

run(process.execPath, [tsc, "-p", join(root, "tsconfig.json")]);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, npm_config_global: "false" },
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
