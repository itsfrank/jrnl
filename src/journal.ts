import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileAtCommit, lastCommitForPath } from "./git.js";
import { exists, writeText } from "./utils.js";

export const PROCESSING_STATE_PATH = "state/processed-notes.json";

export interface ProcessingState {
  version: 1;
  lastProcessedAt: string | null;
  notes: Record<string, string>;
}

export interface NoteChanges {
  newNotes: Array<{ path: string; after: string }>;
  modifiedNotes: Array<{ path: string; before: string | null; after: string }>;
  deletedNotes: Array<{ path: string; before: string | null }>;
  currentHashes: Record<string, string>;
}

export async function createNote(repo: string, text: string, now = new Date()): Promise<string> {
  const normalized = text.trim();
  if (!normalized) throw new Error("Note cannot be empty.");
  const id = `${formatTimestamp(now)}-${randomBytes(3).toString("hex")}`;
  const relativePath = `notes/${now.getUTCFullYear()}/${twoDigits(now.getUTCMonth() + 1)}/${id}.md`;
  const content = `---\nid: ${id}\ncreated_at: ${now.toISOString()}\n---\n\n${normalized}\n`;
  await writeText(join(repo, relativePath), content);
  return relativePath;
}

export async function loadProcessingState(repo: string): Promise<ProcessingState> {
  const path = join(repo, PROCESSING_STATE_PATH);
  if (!await exists(path)) return emptyProcessingState();
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isProcessingState(parsed)) throw new Error(`Invalid processing state: ${PROCESSING_STATE_PATH}`);
  return parsed;
}

export async function saveProcessingState(repo: string, state: ProcessingState): Promise<void> {
  const sortedNotes = Object.fromEntries(Object.entries(state.notes).sort(([a], [b]) => a.localeCompare(b)));
  await writeText(join(repo, PROCESSING_STATE_PATH), `${JSON.stringify({ ...state, notes: sortedNotes }, null, 2)}\n`);
}

export function emptyProcessingState(): ProcessingState {
  return { version: 1, lastProcessedAt: null, notes: {} };
}

export async function detectNoteChanges(repo: string, state: ProcessingState): Promise<NoteChanges> {
  const paths = await listNoteFiles(repo);
  const currentHashes: Record<string, string> = {};
  const currentContents = new Map<string, string>();
  for (const path of paths) {
    const content = await readFile(join(repo, path), "utf8");
    currentContents.set(path, content);
    currentHashes[path] = sha256(content);
  }

  const baseline = await lastCommitForPath(repo, PROCESSING_STATE_PATH);
  const newNotes: NoteChanges["newNotes"] = [];
  const modifiedNotes: NoteChanges["modifiedNotes"] = [];
  const deletedNotes: NoteChanges["deletedNotes"] = [];

  for (const path of paths) {
    const after = currentContents.get(path)!;
    const previousHash = state.notes[path];
    if (!previousHash) {
      newNotes.push({ path, after });
    } else if (previousHash !== currentHashes[path]) {
      modifiedNotes.push({
        path,
        before: baseline ? (await fileAtCommit(repo, baseline, path)) ?? null : null,
        after,
      });
    }
  }

  for (const path of Object.keys(state.notes)) {
    if (!(path in currentHashes)) {
      deletedNotes.push({
        path,
        before: baseline ? (await fileAtCommit(repo, baseline, path)) ?? null : null,
      });
    }
  }

  return { newNotes, modifiedNotes, deletedNotes, currentHashes };
}

export function noteChangeCount(changes: NoteChanges): number {
  return changes.newNotes.length + changes.modifiedNotes.length + changes.deletedNotes.length;
}

export async function writeProcessContext(repo: string, changes: NoteChanges): Promise<string> {
  const relativePath = ".jrnl/process-context.json";
  await mkdir(dirname(join(repo, relativePath)), { recursive: true });
  await writeFile(join(repo, relativePath), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    new: changes.newNotes,
    modified: changes.modifiedNotes,
    deleted: changes.deletedNotes,
  }, null, 2)}\n`, "utf8");
  return relativePath;
}

export async function listNoteFiles(repo: string): Promise<string[]> {
  const root = join(repo, "notes");
  if (!await exists(root)) return [];
  const results: string[] = [];
  await walk(root, results);
  return results
    .filter((path) => path.endsWith(".md"))
    .map((path) => relative(repo, path).split(sep).join("/"))
    .sort();
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-");
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

async function walk(directory: string, results: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, results);
    else if (entry.isFile()) results.push(path);
  }
}

function isProcessingState(value: unknown): value is ProcessingState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ProcessingState>;
  return candidate.version === 1
    && (candidate.lastProcessedAt === null || typeof candidate.lastProcessedAt === "string")
    && typeof candidate.notes === "object"
    && candidate.notes !== null
    && Object.values(candidate.notes).every((hash) => typeof hash === "string");
}
