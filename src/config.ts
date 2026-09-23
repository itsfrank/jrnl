import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import { JrnlError } from "./errors.js";
import { exists, expandHome } from "./utils.js";

export interface JrnlConfig {
  repo: string;
  pi: {
    command: string[];
  };
}

export function configPath(): string {
  return process.env.JRNL_CONFIG_PATH
    ? resolve(process.env.JRNL_CONFIG_PATH)
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "jrnl.toml");
}

export async function hasConfig(): Promise<boolean> {
  return exists(configPath());
}

export async function loadConfig(): Promise<JrnlConfig> {
  const path = configPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new JrnlError(`No configuration found. Run \`jrnl init\` first.\nExpected: ${path}`);
    }
    throw error;
  }

  let value: unknown;
  try {
    value = parse(raw);
  } catch (error) {
    throw new JrnlError(`Invalid configuration at ${path}: ${(error as Error).message}`);
  }

  if (!isObject(value) || typeof value.repo !== "string" || value.repo.trim() === "") {
    throw new JrnlError(`Invalid configuration at ${path}: \`repo\` must be a path.`);
  }
  if (!isObject(value.pi) || !Array.isArray(value.pi.command)) {
    throw new JrnlError(`Invalid configuration at ${path}: \`pi.command\` must be an array.`);
  }
  const command = value.pi.command;
  if (command.length === 0 || !command.every((part): part is string => typeof part === "string" && part !== "")) {
    throw new JrnlError(`Invalid configuration at ${path}: \`pi.command\` must contain strings.`);
  }

  return {
    repo: expandHome(value.repo),
    pi: { command: [...command] },
  };
}

export async function saveConfig(config: JrnlConfig): Promise<void> {
  const path = configPath();
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  const content = stringify({ repo: resolve(config.repo), pi: { command: config.pi.command } });
  await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

export function formatConfig(config: JrnlConfig): string {
  return stringify({ repo: config.repo, pi: { command: config.pi.command } });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
