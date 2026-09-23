# AI Journal CLI — High-Level Plan

`jrnl` is a personal command-line journal for tracking notes, tasks, priorities, and projects across devices.

- A Git repository provides durable, portable storage and change history.
- Raw notes are saved chronologically; AI-maintained Markdown files capture current project memory, priorities, and open tasks.
- `jrnl note "text"` records a note, with `jrnl "text"` as shorthand.
- `jrnl status`, `jrnl ask`, and `jrnl sync` provide supporting workflows.
- `jrnl pi` opens an interactive Pi session with the journal context.
- Agentic operations use Pi's CLI and its configured default model.
- The CLI will be written in TypeScript on Node.js with minimal dependencies.

## `jrnl note`

- Accept note text as arguments or from standard input.
- With no arguments in an interactive terminal, open a temporary Markdown file using `$EDITOR`; require the variable to be set and cancel if the file remains empty or unsaved.
- Store every timestamped note as a separate source file with a stable name and unique suffix.
- Commit the note locally before attempting synchronization.
- Pull/rebase and push automatically after capture.
- Preserve the local commit and report `sync pending` if synchronization cannot complete.
- Leave unexpected conflicts untouched for `jrnl resolve-conflicts`.

## `jrnl process`

- Commit pending human edits under `notes/`, reject unrelated working-tree changes, then synchronize.
- Compare note filenames and content hashes with repository-tracked processing state.
- Classify notes as new, modified, or deleted and tell Pi exactly which notes changed.
- For modified or deleted notes, retrieve the previously processed content from Git and provide Pi with the before and after versions.
- Let Pi update project, priority, task, `memory/STATUS.md`, and other memory files while treating all source notes as read-only.
- Validate the changes, summarize them, and require confirmation.
- After confirmation, record the processed note IDs and hashes, commit all changes, and sync.
- Leave declined or failed notes unprocessed so they can be retried.
- Accept no options beyond `--help`.

## `jrnl ask`

- Accept a question as arguments or standard input.
- Synchronize and invoke Pi in one-shot, non-persistent mode through the configured command.
- Give Pi read-only access to journal memory and raw notes, including unprocessed notes.
- Stream Pi's answer directly to standard output.
- Make no file changes or commits.
- Accept no options beyond `--help`.

## `jrnl status`

- Attempt to synchronize, then print the AI-maintained `memory/STATUS.md` without invoking Pi.
- Add deterministic metadata for new, modified, or deleted notes, last processing time, and repository sync state.
- Mark status stale when note hashes differ from processing state or another memory file changed after `STATUS.md`.
- When offline, display local status with a clear stale or pending-sync warning.
- Make no file changes or commits.
- Accept no arguments or options beyond `--help`.

## Configuration

Configuration lives at `~/.config/jrnl/jrnl.toml` and defines the journal repository and Pi launch command. The Pi command is stored as an argument array so sandbox wrappers can be configured safely.

```toml
repo = "~/path/to/jrnl"

[pi]
command = ["sandbox-wrapper", "pi"]
```

## `jrnl init`

- Interactively ask for the journal folder, Git URL, and Pi command, showing detected defaults that Enter accepts.
- Default the folder to the current directory, the Git URL to the existing `origin`, and the Pi command to `pi`.
- Clone or initialize the repository as needed, configure `origin`, create the config, and perform the first sync.
- Finish successfully only after validating the local repository and remote synchronization.

## `jrnl upgrade`

- Track repository `schema_version` and `agents_version` in `state/jrnl.toml`.
- `jrnl upgrade` updates CLI-managed static files and the managed section of `AGENTS.md` while preserving user instructions.
- `jrnl upgrade --migrate` runs ordered, version-specific storage migrations.
- Use deterministic code for mechanical changes and Pi only for semantic content changes.
- Require a clean, synchronized repository; create a rollback checkpoint; validate and show the final diff; then confirm, commit, and sync.
- Keep migrations sequential, idempotent, and recoverable.
- Warn but continue when only `agents_version` differs.
- When `schema_version` differs, block every command except help, version, and the two upgrade modes; migration owns any required synchronization and conflict resolution.
- Require users to update the installed CLI when the repository schema is newer than the CLI supports.

## Shared synchronization

Folder creation and initial Git setup belong to `jrnl init`. All commands use one shared implementation for routine fetch, pull/rebase, push, pending-sync reporting, and conflict detection. It preserves local commits and leaves unexpected conflicts for explicit resolution.

## `jrnl sync`

- Require a clean working tree and never create commits.
- Fetch, rebase local commits onto the remote branch, and push.
- Abort conflicting rebases and restore the pre-sync state while preserving local commits.
- Report a concise result or a categorized networking, authentication, or conflict error that directs conflicts to `jrnl resolve-conflicts`.
- Accept no options beyond `--help`.

## `jrnl resolve-conflicts`

- Require a clean working tree, fetch, and begin the standard rebase.
- Invoke Pi through the configured command to reconcile only conflicted journal files.
- Keep Git operations under `jrnl` control and give Pi file-editing tools only.
- Validate the resolution, show the proposed diff, and require confirmation before continuing the rebase and pushing.
- Repeat for later conflicting rebase steps when necessary.
- Abort and restore the original local state if resolution fails or is declined.

## `jrnl pi`

- Launch an interactive Pi session in the configured journal repository.
- Use the configured Pi command and let Pi select its configured default model.
- Load journal context and operating instructions from `AGENTS.md`.
- Accept no positional arguments and no command-specific options beyond `--help`.
- Forward every argument following `--` directly to Pi.
