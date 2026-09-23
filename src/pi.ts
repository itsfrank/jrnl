import type { JrnlConfig } from "./config.js";
import { JrnlError } from "./errors.js";
import { runProcess } from "./utils.js";

export async function runInteractivePi(config: JrnlConfig, forwardedArgs: readonly string[]): Promise<void> {
  await invokePi(config, forwardedArgs);
}

export async function runProcessingPi(config: JrnlConfig, prompt: string): Promise<void> {
  await invokePi(config, [
    "--print",
    "--no-session",
    "--tools",
    "read,edit,write,grep,find,ls",
    "--",
    prompt,
  ]);
}

export async function runReadOnlyPi(config: JrnlConfig, prompt: string): Promise<void> {
  await invokePi(config, [
    "--print",
    "--no-session",
    "--tools",
    "read,grep,find,ls",
    "--",
    prompt,
  ]);
}

export async function runConflictPi(config: JrnlConfig, prompt: string): Promise<void> {
  await invokePi(config, [
    "--print",
    "--no-session",
    "--tools",
    "read,edit,write,grep,find,ls",
    "--",
    prompt,
  ]);
}

async function invokePi(config: JrnlConfig, args: readonly string[]): Promise<void> {
  const [command, ...prefixArgs] = config.pi.command;
  if (!command) throw new JrnlError("The configured Pi command is empty.");
  let result;
  try {
    result = await runProcess(command, [...prefixArgs, ...args], { cwd: config.repo, inherit: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new JrnlError(`Could not launch configured Pi command: ${detail}`);
  }
  if (result.code !== 0) {
    throw new JrnlError(`Pi exited with status ${result.code}.`);
  }
}
