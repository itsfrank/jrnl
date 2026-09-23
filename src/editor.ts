import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JrnlError } from "./errors.js";
import { exists, parseCommandLine, runProcess } from "./utils.js";

export function editorCommand(value: string | undefined): string[] {
  if (!value?.trim()) {
    throw new JrnlError("`EDITOR` is not set. Set it to your preferred editor, for example: `export EDITOR=nvim`.");
  }
  return parseCommandLine(value, "`EDITOR`");
}

export async function editNote(editor = process.env.EDITOR): Promise<string | undefined> {
  const [command, ...args] = editorCommand(editor);
  const directory = await mkdtemp(join(tmpdir(), "jrnl-note-"));
  const path = join(directory, "note.md");

  try {
    await writeFile(path, "", { encoding: "utf8", mode: 0o600 });
    let result;
    try {
      result = await runProcess(command!, [...args, path], { inherit: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new JrnlError(`Could not launch editor: ${detail}`);
    }
    if (result.code !== 0) {
      throw new JrnlError(`Editor exited with status ${result.code}.`);
    }

    if (!await exists(path)) return undefined;
    const content = await readFile(path, "utf8");
    return content.trim() ? content : undefined;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
