import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { requireCompatibleRepository } from "./compatibility.js";
import { configPath, formatConfig, hasConfig, loadConfig, saveConfig, type JrnlConfig } from "./config.js";
import { JrnlError } from "./errors.js";
import {
  commitPaths,
  getOrigin,
  git,
  gitStatus,
  hasHead,
  isGitRepository,
  setOrigin,
  syncRepository,
} from "./git.js";
import { emptyProcessingState, PROCESSING_STATE_PATH, saveProcessingState } from "./journal.js";
import { AGENTS_MD, INITIAL_PRIORITIES, INITIAL_STATUS, INITIAL_TASKS } from "./prompts.js";
import { exists, expandHome, parseCommandLine, readStandardInput, runProcess, writeText } from "./utils.js";
import { REPOSITORY_VERSION_PATH, repositoryVersionFile } from "./versions.js";

export async function runInit(): Promise<void> {
  if (await hasConfig()) {
    const existing = await loadConfig();
    if (!await isGitRepository(existing.repo)) {
      throw new JrnlError(`Existing configuration points to a non-Git directory: ${existing.repo}`);
    }
    await requireCompatibleRepository(existing.repo);
    await syncRepository(existing.repo, {
      beforePush: async () => {
        await requireCompatibleRepository(existing.repo, { warnAgents: false });
      },
    });
    console.log(`jrnl is already initialized.\n\n${formatConfig(existing).trim()}\n\nConfiguration: ${configPath()}`);
    return;
  }

  const prompt = await createPromptSession();
  let folder: string;
  let gitUrl: string;
  let piCommand: string[];
  try {
    const folderDefault = resolve(process.cwd());
    const folderAnswer = await prompt.question(`Journal folder [${folderDefault}]: `);
    folder = expandHome(folderAnswer.trim() || folderDefault);

    const detectedOrigin = await detectOrigin(folder);
    while (true) {
      const label = detectedOrigin ? `Git repository URL [${detectedOrigin}]: ` : "Git repository URL: ";
      const answer = (await prompt.question(label)).trim();
      gitUrl = answer || detectedOrigin || "";
      if (gitUrl) break;
      console.log("A Git repository URL is required for synchronization.");
    }

    const commandAnswer = (await prompt.question("Pi command [pi]: ")).trim();
    piCommand = parseCommandLine(commandAnswer || "pi");

    console.log(`\nJournal folder: ${folder}\nGit repository: ${gitUrl}\nPi command: ${JSON.stringify(piCommand)}`);
    const confirmation = (await prompt.question("\nCreate configuration? [Y/n] ")).trim().toLowerCase();
    if (confirmation !== "" && confirmation !== "y" && confirmation !== "yes") {
      console.log("Initialization cancelled.");
      return;
    }
  } finally {
    prompt.close();
  }

  await prepareRepository(folder, gitUrl);
  const created = await scaffoldJournal(folder);
  if (created.length > 0) {
    await commitPaths(folder, created, "Initialize jrnl");
  }
  if (!await hasHead(folder)) {
    throw new JrnlError("Journal repository has no initial commit.");
  }
  if ((await gitStatus(folder)).length > 0) {
    throw new JrnlError("Journal folder contains files outside the generated scaffold. Commit or remove them, then run `jrnl init` again.");
  }
  await syncRepository(folder);

  const config: JrnlConfig = { repo: folder, pi: { command: piCommand } };
  await saveConfig(config);
  console.log(`\njrnl initialized and synced.\nConfiguration: ${configPath()}`);
}

async function detectOrigin(folder: string): Promise<string | undefined> {
  return await isGitRepository(folder) ? getOrigin(folder) : undefined;
}

async function prepareRepository(folder: string, gitUrl: string): Promise<void> {
  if (!await exists(folder)) {
    await mkdir(dirname(folder), { recursive: true });
    await cloneRepository(gitUrl, folder);
    return;
  }

  if (await isGitRepository(folder)) {
    await setOrigin(folder, gitUrl);
    return;
  }

  const entries = await readdir(folder);
  if (entries.length > 0) {
    throw new JrnlError(`Journal folder exists and is not empty: ${folder}`);
  }
  await cloneRepository(gitUrl, folder);
}

async function cloneRepository(gitUrl: string, folder: string): Promise<void> {
  const result = await runProcess("git", ["clone", gitUrl, basename(folder)], { cwd: dirname(folder) });
  if (result.code !== 0) {
    throw new JrnlError(`Could not clone journal repository: ${(result.stderr || result.stdout).trim()}`);
  }
}

export async function scaffoldJournal(repo: string): Promise<string[]> {
  const created: string[] = [];
  await createIfMissing(repo, "AGENTS.md", AGENTS_MD, created);
  await createIfMissing(repo, "memory/STATUS.md", INITIAL_STATUS, created);
  await createIfMissing(repo, "memory/PRIORITIES.md", INITIAL_PRIORITIES, created);
  await createIfMissing(repo, "memory/TASKS.md", INITIAL_TASKS, created);
  await createIfMissing(repo, "memory/projects/.gitkeep", "", created);
  await createIfMissing(repo, "notes/.gitkeep", "", created);
  if (!await exists(join(repo, PROCESSING_STATE_PATH))) {
    await saveProcessingState(repo, emptyProcessingState());
    created.push(PROCESSING_STATE_PATH);
  }
  await createIfMissing(repo, REPOSITORY_VERSION_PATH, repositoryVersionFile(), created);

  const ignorePath = join(repo, ".gitignore");
  if (!await exists(ignorePath)) {
    await writeText(ignorePath, ".jrnl/\n");
    created.push(".gitignore");
  } else {
    const content = await readFile(ignorePath, "utf8");
    if (!content.split(/\r?\n/).includes(".jrnl/")) {
      await writeText(ignorePath, `${content.replace(/\s*$/, "")}\n.jrnl/\n`);
      created.push(".gitignore");
    }
  }
  return created;
}

async function createPromptSession(): Promise<{ question(prompt: string): Promise<string>; close(): void }> {
  if (!stdin.isTTY) {
    const answers = (await readStandardInput()).split(/\r?\n/);
    let index = 0;
    return {
      question: async (prompt) => {
        stdout.write(prompt);
        const answer = answers[index++] ?? "";
        stdout.write(`${answer}\n`);
        return answer;
      },
      close: () => {},
    };
  }

  const rl: Interface = createInterface({ input: stdin, output: stdout });
  return {
    question: (prompt) => rl.question(prompt),
    close: () => rl.close(),
  };
}

async function createIfMissing(repo: string, path: string, content: string, created: string[]): Promise<void> {
  if (!await exists(join(repo, path))) {
    await writeText(join(repo, path), content);
    created.push(path);
  }
}
