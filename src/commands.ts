import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { requireCompatibleRepository } from "./compatibility.js";
import { loadConfig, type JrnlConfig } from "./config.js";
import { GitConflictError, IncompatibleSchemaError, JrnlError } from "./errors.js";
import {
  abortRebase,
  beginRebase,
  changedPaths,
  commitPaths,
  continueRebase,
  diffStat,
  getUnmergedPaths,
  git,
  gitStatus,
  memoryChangedAfterStatus,
  pushCurrentBranch,
  removeTemporaryWork,
  requireClean,
  requireGitRepository,
  restoreClean,
  syncRepository,
} from "./git.js";
import {
  createNote,
  detectNoteChanges,
  loadProcessingState,
  noteChangeCount,
  saveProcessingState,
  writeProcessContext,
} from "./journal.js";
import { displayPiOutput, runConflictPi, runInteractivePi, runProcessingPi, runReadOnlyPi } from "./pi.js";
import { askPrompt, processPrompt, resolvePrompt } from "./prompts.js";
import { confirm, exists, readStandardInput, withActivity } from "./utils.js";

export async function runNote(arguments_: readonly string[]): Promise<void> {
  const config = await loadConfig();
  await withActivity("Checking journal repository", async () => {
    await requireGitRepository(config.repo);
    await requireCompatibleRepository(config.repo);
    await requireClean(config.repo);
  });
  const text = await argumentOrStdin(arguments_, "note");
  const path = await createNote(config.repo, text);
  const commit = await withActivity("Saving note", async () => {
    await commitPaths(config.repo, [path], `jrnl note: ${path.split("/").at(-1)?.replace(/\.md$/, "")}`);
    return (await git(config.repo, ["rev-parse", "--short", "HEAD"])).stdout.trim();
  });

  try {
    await withActivity("Synchronizing note", () => syncCompatibleRepository(config, false));
    console.log(`Note saved and synced.\nFile: ${path}\nCommit: ${commit}`);
  } catch (error) {
    if (error instanceof JrnlError) {
      console.log(`Note saved locally.\nFile: ${path}\nCommit: ${commit}\nSync pending: ${error.message}`);
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
}

export async function runSync(): Promise<void> {
  const config = await loadConfig();
  const result = await withActivity("Synchronizing journal repository", () => syncCompatibleRepository(config));
  console.log(result.pushed ? `Synced ${result.branch}; local commits pushed.` : `Synced ${result.branch}; already up to date.`);
}

export async function runProcessNotes(): Promise<void> {
  const config = await loadConfig();
  await withActivity("Checking journal repository", async () => {
    await requireGitRepository(config.repo);
    await requireCompatibleRepository(config.repo);
  });
  const pendingPaths = await changedPaths(config.repo);
  if (pendingPaths.length > 0) {
    const nonNotes = pendingPaths.filter((path) => !path.startsWith("notes/"));
    if (nonNotes.length > 0) {
      throw new JrnlError(`Journal repository has uncommitted changes outside notes/:\n${nonNotes.join("\n")}`);
    }
    await withActivity("Saving amended source notes", () =>
      commitPaths(config.repo, pendingPaths, "jrnl: amend source notes"));
  }
  await withActivity("Synchronizing source notes", () => syncCompatibleRepository(config, false));
  const changes = await withActivity("Finding unprocessed note changes", async () => {
    const state = await loadProcessingState(config.repo);
    return detectNoteChanges(config.repo, state);
  });
  const count = noteChangeCount(changes);
  if (count === 0) {
    console.log("Memory is up to date; no note changes to process.");
    return;
  }

  const contextPath = await writeProcessContext(config.repo, changes);
  try {
    const result = await withActivity("Pi is updating journal memory", () =>
      runProcessingPi(config, processPrompt(contextPath)));
    displayPiOutput(result);
  } catch (error) {
    await restoreClean(config.repo);
    await removeTemporaryWork(config.repo);
    throw error;
  }
  await removeTemporaryWork(config.repo);

  const paths = await withActivity("Reviewing Pi's changes", () => changedPaths(config.repo));
  const invalid = paths.filter((path) => !path.startsWith("memory/"));
  if (invalid.length > 0) {
    await restoreClean(config.repo);
    throw new JrnlError(`Pi changed files outside memory/: ${invalid.join(", ")}. Changes were discarded.`);
  }

  console.log(`\nProcessed ${count} note change${count === 1 ? "" : "s"}.`);
  if (paths.length > 0) {
    console.log(`Changed:\n${paths.map((path) => `  ${path}`).join("\n")}`);
    const stat = await diffStat(config.repo);
    if (stat) console.log(`\n${stat}`);
  } else {
    console.log("No memory files needed changes.");
  }

  if (!await confirm("Apply, commit, and sync?")) {
    await restoreClean(config.repo);
    console.log("Processing changes discarded; notes remain unprocessed.");
    return;
  }

  await withActivity("Committing memory updates", async () => {
    await saveProcessingState(config.repo, {
      version: 1,
      lastProcessedAt: new Date().toISOString(),
      notes: changes.currentHashes,
    });
    await commitPaths(config.repo, ["memory", "state/processed-notes.json"], `jrnl process: ${count} note change${count === 1 ? "" : "s"}`);
  });
  try {
    await withActivity("Synchronizing memory updates", () => syncCompatibleRepository(config, false));
    console.log("Memory updated and synced.");
  } catch (error) {
    if (error instanceof JrnlError) {
      console.log(`Memory updated locally.\nSync pending: ${error.message}`);
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
}

export async function runAsk(arguments_: readonly string[]): Promise<void> {
  const config = await loadConfig();
  const question = await argumentOrStdin(arguments_, "question");
  await withActivity("Synchronizing journal repository", () => syncCompatibleRepository(config));
  const result = await withActivity("Pi is searching the journal", () => runReadOnlyPi(config, askPrompt(question)));
  displayPiOutput(result);
}

export async function runStatus(): Promise<void> {
  const config = await loadConfig();
  await requireGitRepository(config.repo);
  await requireCompatibleRepository(config.repo);
  let syncState = "synced";
  try {
    await withActivity("Synchronizing journal repository", () => syncCompatibleRepository(config, false));
  } catch (error) {
    if (error instanceof IncompatibleSchemaError) throw error;
    syncState = `freshness unknown — ${error instanceof Error ? error.message : String(error)}`;
  }

  const statusPath = join(config.repo, "memory/STATUS.md");
  const status = await exists(statusPath) ? (await readFile(statusPath, "utf8")).trim() : "# Status\n\nNo status has been generated.";
  const { state, changes, memoryChanged } = await withActivity("Checking status freshness", async () => {
    const state = await loadProcessingState(config.repo);
    const changes = await detectNoteChanges(config.repo, state);
    const memoryChanged = await memoryChangedAfterStatus(config.repo);
    return { state, changes, memoryChanged };
  });
  const changeCount = noteChangeCount(changes);
  const staleReasons: string[] = [];
  if (changeCount > 0) {
    staleReasons.push(`${changes.newNotes.length} new, ${changes.modifiedNotes.length} modified, ${changes.deletedNotes.length} deleted notes`);
  }
  if (memoryChanged) staleReasons.push("memory changed after STATUS.md");
  if (syncState !== "synced") staleReasons.push("remote freshness unknown");

  console.log(status);
  console.log("\n---");
  console.log(`Status: ${staleReasons.length > 0 ? `stale — ${staleReasons.join("; ")}` : "current"}`);
  console.log(`Last processed: ${state.lastProcessedAt ?? "never"}`);
  console.log(`Repository: ${syncState}`);
}

export async function runPi(forwardedArgs: readonly string[]): Promise<void> {
  const config = await loadConfig();
  await withActivity("Synchronizing journal repository", () => syncCompatibleRepository(config));
  await runInteractivePi(config, forwardedArgs);

  const status = await gitStatus(config.repo);
  if (status) {
    console.log(`\nPi changed files:\n${status}`);
    if (!await confirm("Commit and sync these changes?")) {
      console.log("Changes left in the working tree.");
      return;
    }
    await git(config.repo, ["add", "-A"]);
    await git(config.repo, ["commit", "-m", "jrnl: update from Pi session"]);
  }
  await withActivity("Synchronizing Pi changes", () => syncCompatibleRepository(config, false));
}

export async function runResolveConflicts(skipCompatibility = false): Promise<void> {
  const config = await loadConfig();
  if (!skipCompatibility) await requireCompatibleRepository(config.repo);
  let phase: "complete" | "conflict";
  try {
    phase = await withActivity("Fetching remote changes", () => beginRebase(config.repo));
    if (!skipCompatibility) await requireCompatibleRepository(config.repo, { warnAgents: false });
    while (phase === "conflict") {
      const conflicts = await getUnmergedPaths(config.repo);
      const result = await withActivity("Pi is resolving merge conflicts", () =>
        runConflictPi(config, resolvePrompt(conflicts)));
      displayPiOutput(result);

      const unstaged = (await git(config.repo, ["diff", "--name-only"])).stdout.split("\n").map((path) => path.trim()).filter(Boolean);
      const untracked = (await git(config.repo, ["ls-files", "--others", "--exclude-standard"])).stdout.split("\n").map((path) => path.trim()).filter(Boolean);
      const invalid = [...new Set([...unstaged, ...untracked])].filter((path) => !conflicts.includes(path));
      if (invalid.length > 0) {
        throw new JrnlError(`Pi changed files outside the conflict set: ${invalid.join(", ")}`);
      }
      for (const path of conflicts) {
        if (!await exists(join(config.repo, path))) continue;
        const content = await readFile(join(config.repo, path), "utf8");
        if (/^(<{7}|={7}|>{7})/m.test(content)) {
          throw new JrnlError(`Conflict markers remain in ${path}.`);
        }
      }

      const stat = await diffStat(config.repo);
      console.log(`\nPi resolved conflicts in:\n${conflicts.map((path) => `  ${path}`).join("\n")}`);
      if (stat) console.log(`\n${stat}`);
      if (!await confirm("Apply resolution and sync?")) {
        await abortRebase(config.repo);
        console.log("Resolution declined; original local state restored.");
        return;
      }

      await git(config.repo, ["add", "--", ...conflicts]);
      phase = await continueRebase(config.repo);
    }
    if (!skipCompatibility) await requireCompatibleRepository(config.repo, { warnAgents: false });
    await withActivity("Pushing resolved changes", () => pushCurrentBranch(config.repo));
    console.log("Conflicts resolved and repository synced.");
  } catch (error) {
    await abortRebase(config.repo);
    if (error instanceof GitConflictError) throw error;
    throw error;
  }
}

async function syncCompatibleRepository(config: JrnlConfig, warnAgents = true) {
  await requireCompatibleRepository(config.repo, { warnAgents });
  return syncRepository(config.repo, {
    beforePush: async () => {
      await requireCompatibleRepository(config.repo, { warnAgents: false });
    },
  });
}

async function argumentOrStdin(arguments_: readonly string[], label: string): Promise<string> {
  if (arguments_.some((argument) => argument.startsWith("-"))) {
    throw new JrnlError(`Unknown option. Pass ${label} text as arguments or standard input.`);
  }
  const argumentText = arguments_.join(" ").trim();
  if (argumentText) return argumentText;
  if (!process.stdin.isTTY) {
    const piped = (await readStandardInput()).trim();
    if (piped) return piped;
  }
  throw new JrnlError(`Missing ${label} text.`);
}
