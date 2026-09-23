#!/usr/bin/env node

import { createRequire } from "node:module";
import {
  runAsk,
  runNote,
  runPath,
  runPi,
  runProcessNotes,
  runResolveConflicts,
  runStatus,
  runSync,
} from "./commands.js";
import { JrnlError } from "./errors.js";
import { runInit } from "./init.js";
import { runUpgrade } from "./upgrade.js";

const { version: VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };

const HELP = `jrnl — a Git-backed, AI-assisted personal journal

Usage:
  jrnl init
  jrnl note [text]            Open $EDITOR when text is omitted
  jrnl <text>                 Shorthand for jrnl note <text>
  jrnl process
  jrnl upgrade [--migrate]
  jrnl ask <question>
  jrnl status
  jrnl sync
  jrnl path
  jrnl resolve-conflicts
  jrnl pi [-- <pi arguments>]

Options:
  -h, --help                  Show help
  -v, --version               Show version
`;

const COMMAND_HELP: Record<string, string> = {
  init: "Usage: jrnl init\n\nInteractively configure and synchronize a journal repository.",
  note: "Usage: jrnl note [text]\n       echo <text> | jrnl note\n\nSave, commit, and synchronize a source note. With no text, open $EDITOR (which must be set).",
  process: "Usage: jrnl process\n\nUse Pi to process changed notes into journal memory.",
  upgrade: "Usage: jrnl upgrade [--migrate]\n\nUpdate managed static files, or migrate an older repository schema.",
  ask: "Usage: jrnl ask <question>\n       echo <question> | jrnl ask\n\nAsk Pi a read-only question about the journal.",
  status: "Usage: jrnl status\n\nShow current journal status and freshness.",
  sync: "Usage: jrnl sync\n\nSynchronize the clean journal repository.",
  path: "Usage: jrnl path\n\nPrint the configured journal repository path.",
  "resolve-conflicts": "Usage: jrnl resolve-conflicts\n\nUse Pi to propose and confirm Git conflict resolutions.",
  pi: "Usage: jrnl pi [-- <pi arguments>]\n\nOpen interactive Pi in the journal repository. Arguments after -- are forwarded to Pi.",
};

async function main(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
    return;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    console.log(VERSION);
    return;
  }

  const command = args[0]!;
  const rest = args.slice(1);
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h") && command in COMMAND_HELP) {
    console.log(COMMAND_HELP[command]);
    return;
  }

  switch (command) {
    case "init":
      requireNoArguments(command, rest);
      await runInit();
      return;
    case "note":
      await runNote(rest);
      return;
    case "process":
      requireNoArguments(command, rest);
      await runProcessNotes();
      return;
    case "upgrade":
      if (rest.length === 0) {
        await runUpgrade(false);
      } else if (rest.length === 1 && rest[0] === "--migrate") {
        await runUpgrade(true);
      } else {
        throw new JrnlError("Usage: jrnl upgrade [--migrate]");
      }
      return;
    case "ask":
      await runAsk(rest);
      return;
    case "status":
      requireNoArguments(command, rest);
      await runStatus();
      return;
    case "sync":
      requireNoArguments(command, rest);
      await runSync();
      return;
    case "path":
      requireNoArguments(command, rest);
      await runPath();
      return;
    case "resolve-conflicts":
      requireNoArguments(command, rest);
      await runResolveConflicts();
      return;
    case "pi": {
      const separator = rest.indexOf("--");
      if (separator === -1) {
        requireNoArguments(command, rest);
        await runPi([]);
      } else {
        if (separator !== 0) throw new JrnlError("`jrnl pi` accepts Pi arguments only after `--`.");
        await runPi(rest.slice(1));
      }
      return;
    }
    default:
      await runNote(args);
  }
}

function requireNoArguments(command: string, args: readonly string[]): void {
  if (args.length > 0) throw new JrnlError(`\`jrnl ${command}\` accepts no arguments. See \`jrnl ${command} --help\`.`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof JrnlError) {
    console.error(`Error: ${error.message}`);
    process.exitCode = error.exitCode;
    return;
  }
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${detail}`);
  process.exitCode = 1;
});
