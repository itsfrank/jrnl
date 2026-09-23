import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { GitConflictError, JrnlError, SyncPendingError } from "./errors.js";
import { exists, oneLine, runProcess } from "./utils.js";

export interface SyncResult {
  branch: string;
  pushed: boolean;
}

export interface SyncOptions {
  beforePush?: () => Promise<void>;
}

export async function git(repo: string, args: readonly string[], allowFailure = false) {
  const result = await runProcess("git", args, { cwd: repo });
  if (!allowFailure && result.code !== 0) {
    throw gitError(args, result.stderr || result.stdout);
  }
  return result;
}

export async function isGitRepository(path: string): Promise<boolean> {
  if (!(await exists(path))) return false;
  const result = await git(path, ["rev-parse", "--is-inside-work-tree"], true);
  return result.code === 0 && result.stdout.trim() === "true";
}

export async function requireGitRepository(path: string): Promise<void> {
  if (!(await isGitRepository(path))) {
    throw new JrnlError(`Not a Git repository: ${path}`);
  }
}

export async function requireClean(repo: string): Promise<void> {
  const status = await gitStatus(repo);
  if (status.length > 0) {
    throw new JrnlError(`Journal repository has uncommitted changes:\n${status}\nCommit or discard them before continuing.`);
  }
}

export async function gitStatus(repo: string): Promise<string> {
  return (await git(repo, ["status", "--short"])).stdout.trim();
}

export async function getOrigin(repo: string): Promise<string | undefined> {
  const result = await git(repo, ["remote", "get-url", "origin"], true);
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

export async function setOrigin(repo: string, url: string): Promise<void> {
  if (await getOrigin(repo)) {
    await git(repo, ["remote", "set-url", "origin", url]);
  } else {
    await git(repo, ["remote", "add", "origin", url]);
  }
}

export async function currentBranch(repo: string): Promise<string> {
  const result = await git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"], true);
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new JrnlError("The journal repository must be on a named branch.");
  }
  return result.stdout.trim();
}

export async function hasHead(repo: string): Promise<boolean> {
  return (await git(repo, ["rev-parse", "--verify", "HEAD"], true)).code === 0;
}

export async function commitPaths(repo: string, paths: readonly string[], message: string): Promise<boolean> {
  await git(repo, ["add", "--", ...paths]);
  const empty = await git(repo, ["diff", "--cached", "--quiet"], true);
  if (empty.code === 0) return false;
  await git(repo, ["commit", "-m", message]);
  return true;
}

export async function syncRepository(repo: string, options: SyncOptions = {}): Promise<SyncResult> {
  await requireGitRepository(repo);
  await requireClean(repo);
  const origin = await getOrigin(repo);
  if (!origin) throw new JrnlError("Journal repository has no `origin` remote.");
  if (!(await hasHead(repo))) throw new JrnlError("Journal repository has no commits to synchronize.");

  const branch = await currentBranch(repo);
  const fetch = await git(repo, ["fetch", "origin"], true);
  if (fetch.code !== 0) throw syncError("fetch", fetch.stderr || fetch.stdout);

  const remoteRef = `refs/remotes/origin/${branch}`;
  const remoteExists = (await git(repo, ["show-ref", "--verify", "--quiet", remoteRef], true)).code === 0;
  if (remoteExists) {
    const rebase = await git(repo, ["rebase", remoteRef], true);
    if (rebase.code !== 0) {
      if ((await getUnmergedPaths(repo)).length > 0 || (await rebaseInProgress(repo))) {
        await abortRebase(repo);
        throw new GitConflictError();
      }
      throw gitError(["rebase", remoteRef], rebase.stderr || rebase.stdout);
    }
  }

  const ahead = remoteExists
    ? Number((await git(repo, ["rev-list", "--count", `${remoteRef}..HEAD`])).stdout.trim())
    : 1;
  await options.beforePush?.();
  const push = await git(repo, ["push", "-u", "origin", `HEAD:${branch}`], true);
  if (push.code !== 0) throw syncError("push", push.stderr || push.stdout);
  return { branch, pushed: ahead > 0 };
}

export async function beginRebase(repo: string): Promise<"complete" | "conflict"> {
  await requireGitRepository(repo);
  await requireClean(repo);
  if (!await getOrigin(repo)) throw new JrnlError("Journal repository has no `origin` remote.");
  const branch = await currentBranch(repo);
  const fetch = await git(repo, ["fetch", "origin"], true);
  if (fetch.code !== 0) throw syncError("fetch", fetch.stderr || fetch.stdout);
  const remoteRef = `refs/remotes/origin/${branch}`;
  const remoteExists = (await git(repo, ["show-ref", "--verify", "--quiet", remoteRef], true)).code === 0;
  if (!remoteExists) return "complete";
  const rebase = await git(repo, ["rebase", remoteRef], true);
  if (rebase.code === 0) return "complete";
  if ((await getUnmergedPaths(repo)).length > 0) return "conflict";
  if (await rebaseInProgress(repo)) await abortRebase(repo);
  throw gitError(["rebase", remoteRef], rebase.stderr || rebase.stdout);
}

export async function continueRebase(repo: string): Promise<"complete" | "conflict"> {
  const environment = { ...process.env, GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };
  const result = await runProcess("git", ["rebase", "--continue"], { cwd: repo, env: environment });
  if (result.code === 0) return "complete";
  if ((await getUnmergedPaths(repo)).length > 0) return "conflict";

  const output = result.stderr || result.stdout;
  if (await rebaseInProgress(repo) && /empty|no changes|nothing to commit/i.test(output)) {
    const skipped = await runProcess("git", ["rebase", "--skip"], { cwd: repo, env: environment });
    if (skipped.code === 0) return "complete";
    if ((await getUnmergedPaths(repo)).length > 0) return "conflict";
    throw gitError(["rebase", "--skip"], skipped.stderr || skipped.stdout);
  }
  throw gitError(["rebase", "--continue"], output);
}

export async function abortRebase(repo: string): Promise<void> {
  if (await rebaseInProgress(repo)) {
    await git(repo, ["rebase", "--abort"], true);
  }
}

export async function getUnmergedPaths(repo: string): Promise<string[]> {
  const output = (await git(repo, ["diff", "--name-only", "--diff-filter=U"])).stdout;
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function rebaseInProgress(repo: string): Promise<boolean> {
  const path = (await git(repo, ["rev-parse", "--git-path", "rebase-merge"], true)).stdout.trim();
  const applyPath = (await git(repo, ["rev-parse", "--git-path", "rebase-apply"], true)).stdout.trim();
  const resolvedPath = isAbsolute(path) ? path : join(repo, path);
  const resolvedApplyPath = isAbsolute(applyPath) ? applyPath : join(repo, applyPath);
  return (path !== "" && await exists(resolvedPath)) || (applyPath !== "" && await exists(resolvedApplyPath));
}

export async function pushCurrentBranch(repo: string): Promise<void> {
  const branch = await currentBranch(repo);
  const result = await git(repo, ["push", "-u", "origin", `HEAD:${branch}`], true);
  if (result.code !== 0) throw syncError("push", result.stderr || result.stdout);
}

export async function changedPaths(repo: string): Promise<string[]> {
  const output = (await git(repo, ["status", "--porcelain"])).stdout;
  return output
    .split("\n")
    .map((line) => line.length >= 4 ? line.slice(3).trim() : "")
    .filter(Boolean)
    .map((path) => path.includes(" -> ") ? path.split(" -> ").at(-1)! : path);
}

export async function diffStat(repo: string): Promise<string> {
  const unstaged = (await git(repo, ["diff", "--stat"])).stdout.trim();
  const staged = (await git(repo, ["diff", "--cached", "--stat"])).stdout.trim();
  return [staged, unstaged].filter(Boolean).join("\n");
}

export async function restoreClean(repo: string): Promise<void> {
  await git(repo, ["reset", "--hard", "HEAD"], true);
  await git(repo, ["clean", "-fd"], true);
}

export async function lastCommitForPath(repo: string, path: string): Promise<string | undefined> {
  const result = await git(repo, ["log", "-1", "--format=%H", "--", path], true);
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

export async function fileAtCommit(repo: string, commit: string, path: string): Promise<string | undefined> {
  const result = await git(repo, ["show", `${commit}:${path}`], true);
  return result.code === 0 ? result.stdout : undefined;
}

export async function commitForPath(repo: string, path: string): Promise<string | undefined> {
  return lastCommitForPath(repo, path);
}

export async function memoryChangedAfterStatus(repo: string): Promise<boolean> {
  const baseline = await git(repo, [
    "log",
    "-1",
    "--format=%H",
    "--",
    "memory/STATUS.md",
    "state/processed-notes.json",
  ], true);
  const baselineCommit = baseline.stdout.trim();
  if (!baselineCommit) return true;
  const changed = await git(repo, ["diff", "--name-only", `${baselineCommit}..HEAD`, "--", "memory"], true);
  return changed.stdout.split("\n").some((path) => path.trim() !== "" && path.trim() !== "memory/STATUS.md");
}

export async function removeTemporaryWork(repo: string): Promise<void> {
  await rm(join(repo, ".jrnl"), { recursive: true, force: true });
}

function syncError(operation: string, output: string): JrnlError {
  const detail = oneLine(output) || `Git ${operation} failed.`;
  if (/auth|authentication|permission denied|could not read username|403|401/i.test(detail)) {
    return new SyncPendingError(`Git authentication failed during ${operation}: ${detail}`);
  }
  if (/could not resolve|unable to access|network|timed out|connection|offline/i.test(detail)) {
    return new SyncPendingError(`Git network failure during ${operation}: ${detail}`);
  }
  return new SyncPendingError(`Git ${operation} failed: ${detail}`);
}

function gitError(args: readonly string[], output: string): JrnlError {
  return new JrnlError(`Git command failed (git ${args.join(" ")}): ${oneLine(output) || "unknown error"}`);
}
