import { stderr, stdout } from "node:process";
import type { JrnlConfig } from "./config.js";
import { JrnlError } from "./errors.js";
import { oneLine, runProcess, type ProcessResult } from "./utils.js";

export async function runInteractivePi(config: JrnlConfig, forwardedArgs: readonly string[]): Promise<void> {
  await invokePi(config, forwardedArgs, true);
}

export async function runProcessingPi(config: JrnlConfig, prompt: string): Promise<ProcessResult> {
  return invokePi(config, [
    "--print",
    "--no-session",
    "--tools",
    "read,edit,write,grep,find,ls",
    "--",
    prompt,
  ], false);
}

export async function runReadOnlyPi(config: JrnlConfig, prompt: string): Promise<ProcessResult> {
  return invokePi(config, [
    "--print",
    "--no-session",
    "--tools",
    "read,grep,find,ls",
    "--",
    prompt,
  ], false);
}

export async function runConflictPi(config: JrnlConfig, prompt: string): Promise<ProcessResult> {
  return invokePi(config, [
    "--print",
    "--no-session",
    "--tools",
    "read,edit,write,grep,find,ls",
    "--",
    prompt,
  ], false);
}

export function displayPiOutput(result: ProcessResult): void {
  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
}

async function invokePi(config: JrnlConfig, args: readonly string[], inherit: boolean): Promise<ProcessResult> {
  const [command, ...prefixArgs] = config.pi.command;
  if (!command) throw new JrnlError("The configured Pi command is empty.");
  let result;
  try {
    result = await runProcess(command, [...prefixArgs, ...args], { cwd: config.repo, inherit });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new JrnlError(`Could not launch configured Pi command: ${detail}`);
  }
  if (result.code !== 0) {
    const detail = oneLine(result.stderr || result.stdout);
    throw new JrnlError(`Pi exited with status ${result.code}${detail ? `: ${detail}` : "."}`);
  }
  return result;
}
