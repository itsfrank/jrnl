import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stderr, stdin, stdout } from "node:process";
import { JrnlError } from "./errors.js";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  inherit?: boolean;
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });

    let processStdout = "";
    let processStderr = "";
    if (!options.inherit) {
      child.stdout?.on("data", (chunk: Buffer) => {
        processStdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        processStderr += chunk.toString();
      });
    }

    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout: processStdout, stderr: processStderr });
    });
  });
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Show an animated, elapsed-time status while a task is running in a terminal. */
export async function withActivity<T>(message: string, task: () => Promise<T>): Promise<T> {
  if (!stderr.isTTY || process.env.TERM === "dumb") return task();

  const startedAt = Date.now();
  let frame = 0;
  const render = () => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    const elapsed = elapsedSeconds < 60
      ? `${elapsedSeconds}s`
      : `${Math.floor(elapsedSeconds / 60)}m ${String(elapsedSeconds % 60).padStart(2, "0")}s`;
    stderr.write(`\r\x1b[2K${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${message} (${elapsed})`);
    frame += 1;
  };

  render();
  const timer = setInterval(render, 80);
  timer.unref();
  try {
    return await task();
  } finally {
    clearInterval(timer);
    stderr.write("\r\x1b[2K");
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

export async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

export async function confirm(prompt: string): Promise<boolean> {
  const answer = (await ask(`${prompt} [Y/n] `)).trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

/** Parse a command line into argv without invoking a shell. */
export function parseCommandLine(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;
  let started = false;

  for (const character of input.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "single") {
      escaped = true;
      started = true;
      continue;
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
      started = true;
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
      started = true;
      continue;
    }
    if (/\s/.test(character) && quote === undefined) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }

  if (escaped || quote !== undefined) {
    throw new JrnlError("Pi command contains an unmatched quote or trailing escape.");
  }
  if (started) args.push(current);
  if (args.length === 0) throw new JrnlError("Pi command cannot be empty.");
  return args;
}

export function oneLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
