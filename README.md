# jrnl

A Git-backed, AI-assisted personal journal for the terminal. Raw notes are stored as individual Markdown files; Pi turns changed notes into concise project memory when asked.

## Install

Install the latest version directly from GitHub:

```bash
npm install --global git+https://github.com/itsfrank/jrnl.git
```

To install a specific tag, branch, or commit, append a Git ref:

```bash
npm install --global git+https://github.com/itsfrank/jrnl.git#<ref>
```

npm runs the package's `prepare` script after cloning, which compiles the TypeScript source before installing the CLI. Requires Node.js 22+, Git, and access to Pi either directly or through a configured sandbox command.

## Development setup

```bash
npm install
npm run build
npm link
```

Build output in `dist/` is generated locally and ignored by Git.

## Initialize

Create or choose a remote Git repository, then run:

```bash
jrnl init
```

The interactive setup asks for the local journal folder, Git URL, and Pi command. Configuration is stored in `~/.config/jrnl.toml`:

```toml
repo = "/absolute/path/to/journal"

[pi]
command = [ "pi" ]
```

A sandbox launcher can be represented as an argument array, for example:

```toml
[pi]
command = [ "sandbox-wrapper", "pi" ]
```

Pi uses its own configured default model.

## Commands

```bash
jrnl note "Atlas is blocked on security review"
jrnl "Finished the migration"        # note shorthand
echo "Follow up Friday" | jrnl note

jrnl process                          # update memory from changed notes
jrnl upgrade                          # update managed static files
jrnl upgrade --migrate                # migrate repository storage
jrnl status                           # show current status and freshness
jrnl ask "What is blocked?"           # read-only one-shot question
jrnl sync
jrnl resolve-conflicts
jrnl pi                               # interactive Pi with journal context
jrnl pi -- --thinking high            # forward arguments to Pi
```

Run `jrnl <command> --help` for command-specific help.

## Journal layout

```text
AGENTS.md
notes/<year>/<month>/<timestamp>-<id>.md
memory/STATUS.md
memory/PRIORITIES.md
memory/TASKS.md
memory/projects/
state/processed-notes.json
state/jrnl.toml                     # schema and managed-prompt versions
```

Agents treat source notes and CLI state as read-only during normal operation. `jrnl process` commits human note amendments, detects new, amended, and deleted notes using content hashes, then shows AI-proposed memory changes before committing them.
