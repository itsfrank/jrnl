import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { configPath, loadConfig } from "../dist/config.js";
import { editNote, editorCommand } from "../dist/editor.js";
import { parseCommandLine } from "../dist/utils.js";

const cli = join(process.cwd(), "dist/cli.js");
const gitIdentity = {
  GIT_AUTHOR_NAME: "jrnl test",
  GIT_AUTHOR_EMAIL: "jrnl@example.invalid",
  GIT_COMMITTER_NAME: "jrnl test",
  GIT_COMMITTER_EMAIL: "jrnl@example.invalid",
};

test("parseCommandLine preserves quoted command arguments", () => {
  assert.deepEqual(parseCommandLine(`sandbox run --name "work journal" pi`), [
    "sandbox",
    "run",
    "--name",
    "work journal",
    "pi",
  ]);
});

test("editor note input captures Markdown and handles cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "jrnl-editor-test-"));
  const fakeEditor = join(root, "fake-editor");
  await writeFile(fakeEditor, `#!/bin/sh
case "$1" in
  "long note")
    cat > "$2" <<'EOF'
# Project update

- First item
- Second item
EOF
    ;;
  blank)
    printf '  \\n\\n' > "$2"
    ;;
  untouched)
    ;;
  fail)
    exit 7
    ;;
esac
`, "utf8");
  await chmod(fakeEditor, 0o755);

  assert.throws(
    () => editorCommand(undefined),
    /`EDITOR` is not set.*export EDITOR=nvim/,
  );
  assert.equal(
    await editNote(`${fakeEditor} "long note"`),
    "# Project update\n\n- First item\n- Second item\n",
  );
  assert.equal(await editNote(`${fakeEditor} blank`), undefined);
  assert.equal(await editNote(`${fakeEditor} untouched`), undefined);
  await assert.rejects(editNote(`${fakeEditor} fail`), /Editor exited with status 7/);
});

test("config uses an application directory and migrates the legacy path", async () => {
  const root = await mkdtemp(join(tmpdir(), "jrnl-config-test-"));
  const legacyPath = join(root, "jrnl.toml");
  const expectedPath = join(root, "jrnl", "jrnl.toml");
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const previousConfigPath = process.env.JRNL_CONFIG_PATH;

  try {
    process.env.XDG_CONFIG_HOME = root;
    delete process.env.JRNL_CONFIG_PATH;
    const content = 'repo = "/tmp/journal"\n\n[pi]\ncommand = [ "pi" ]\n';
    await writeFile(legacyPath, content);

    assert.equal(configPath(), expectedPath);
    assert.deepEqual(await loadConfig(), { repo: "/tmp/journal", pi: { command: ["pi"] } });
    assert.equal(await readFile(expectedPath, "utf8"), content);
    await assert.rejects(readFile(legacyPath, "utf8"), { code: "ENOENT" });
  } finally {
    restoreEnvironment("XDG_CONFIG_HOME", previousXdgConfigHome);
    restoreEnvironment("JRNL_CONFIG_PATH", previousConfigPath);
  }
});

test("init, note, process, amendment detection, status, and ask", async () => {
  const root = await mkdtemp(join(tmpdir(), "jrnl-test-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "journal");
  const config = join(root, "config", "jrnl.toml");
  const capture = join(root, "process-context.json");
  const capturedArgs = join(root, "pi-args.txt");
  git(root, ["init", "--bare", remote]);

  const fakePi = join(root, "fake-pi");
  await writeFile(fakePi, `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_ARGS"
if [ -f .jrnl/process-context.json ]; then
  cp .jrnl/process-context.json "$FAKE_CAPTURE"
  cat > memory/STATUS.md <<'EOF'
# Status

- Atlas — blocked on security review
EOF
  echo "Memory updated."
else
  echo "Atlas is blocked on security review."
fi
`, "utf8");
  await chmod(fakePi, 0o755);

  const env = { ...process.env, ...gitIdentity, JRNL_CONFIG_PATH: config, FAKE_CAPTURE: capture, FAKE_ARGS: capturedArgs };
  const initialized = run(["init"], env, `${repo}\n${remote}\n${fakePi}\n\n`);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.match(initialized.stdout, /initialized and synced/);
  assert.equal(await readFile(join(repo, "state/jrnl.toml"), "utf8"), "schema_version = 1\nagents_version = 1\n");
  const agents = await readFile(join(repo, "AGENTS.md"), "utf8");
  assert.match(agents, /jrnl:managed:start version=1/);
  assert.match(agents, /## Personal Instructions/);

  const noted = run(["note", "Atlas is blocked on security review"], env);
  assert.equal(noted.status, 0, noted.stderr);
  assert.match(noted.stdout, /Note saved and synced/);

  const stale = run(["status"], env);
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stdout, /Status: stale — 1 new/);

  const processed = run(["process"], env, "y\n");
  assert.equal(processed.status, 0, processed.stderr);
  assert.match(processed.stdout, /Memory updated and synced/);

  const notePath = git(repo, ["ls-files", "notes/**/*.md"]).stdout.trim();
  const original = await readFile(join(repo, notePath), "utf8");
  await writeFile(join(repo, notePath), original.replace("blocked on security review", "waiting on load-test results"));

  const modifiedStatus = run(["status"], env);
  assert.equal(modifiedStatus.status, 0, modifiedStatus.stderr);
  assert.match(modifiedStatus.stdout, /1 modified/);

  const reprocessed = run(["process"], env, "y\n");
  assert.equal(reprocessed.status, 0, reprocessed.stderr);
  const context = JSON.parse(await readFile(capture, "utf8"));
  assert.equal(context.modified.length, 1);
  assert.match(context.modified[0].before, /blocked on security review/);
  assert.match(context.modified[0].after, /waiting on load-test results/);

  const current = run(["status"], env);
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /Status: current/);

  const asked = run(["ask", "What is blocked?"], env);
  assert.equal(asked.status, 0, asked.stderr);
  assert.match(asked.stdout, /Atlas is blocked/);
  assert.match(await readFile(capturedArgs, "utf8"), /read,grep,find,ls/);

  const interactive = run(["pi", "--", "--thinking", "high"], env);
  assert.equal(interactive.status, 0, interactive.stderr);
  assert.equal(await readFile(capturedArgs, "utf8"), "--thinking\nhigh\n");
});

test("upgrade warns for agent drift and migrates incompatible schemas", async () => {
  const root = await mkdtemp(join(tmpdir(), "jrnl-upgrade-test-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "journal");
  const config = join(root, "config", "jrnl.toml");
  git(root, ["init", "--bare", remote]);
  const env = { ...process.env, ...gitIdentity, JRNL_CONFIG_PATH: config };
  assert.equal(run(["init"], env, `${repo}\n${remote}\npi\n\n`).status, 0);

  const agentsPath = join(repo, "AGENTS.md");
  const agents = await readFile(agentsPath, "utf8");
  await writeFile(agentsPath, agents.replace("version=1", "version=0").replace(
    "Add journal-specific instructions here. This section is preserved by `jrnl upgrade`.",
    "Always keep my project summaries short.",
  ));
  await writeFile(join(repo, "state/jrnl.toml"), "schema_version = 1\nagents_version = 0\n");
  git(repo, ["add", "AGENTS.md", "state/jrnl.toml"]);
  git(repo, ["commit", "-m", "Simulate old agent template"]);
  git(repo, ["push"]);

  const warned = run(["status"], env);
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /agent instructions are outdated/);
  const staticUpgrade = run(["upgrade"], env, "y\n");
  assert.equal(staticUpgrade.status, 0, staticUpgrade.stderr);
  assert.match(await readFile(agentsPath, "utf8"), /Always keep my project summaries short/);
  assert.equal(await readFile(join(repo, "state/jrnl.toml"), "utf8"), "schema_version = 1\nagents_version = 1\n");

  await writeFile(agentsPath, "# Legacy personal instructions\n\nPreserve this sentence.\n");
  await writeFile(join(repo, "state/jrnl.toml"), "schema_version = 0\nagents_version = 0\n");
  git(repo, ["add", "AGENTS.md", "state/jrnl.toml"]);
  git(repo, ["commit", "-m", "Simulate legacy schema"]);
  git(repo, ["push"]);

  const blockedStatus = run(["status"], env);
  assert.equal(blockedStatus.status, 4);
  assert.match(blockedStatus.stderr, /upgrade --migrate/);
  const blockedSync = run(["sync"], env);
  assert.equal(blockedSync.status, 4);
  const blockedResolve = run(["resolve-conflicts"], env);
  assert.equal(blockedResolve.status, 4);

  const migrationRequired = run(["upgrade"], env);
  assert.equal(migrationRequired.status, 4);
  const migrated = run(["upgrade", "--migrate"], env, "y\n");
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.match(migrated.stdout, /migrated and synced/);
  const migratedAgents = await readFile(agentsPath, "utf8");
  assert.match(migratedAgents, /jrnl:managed:start version=1/);
  assert.match(migratedAgents, /Preserve this sentence/);
  assert.equal(await readFile(join(repo, "state/jrnl.toml"), "utf8"), "schema_version = 1\nagents_version = 1\n");
});

test("resolve-conflicts uses Pi and completes the rebase", async () => {
  const root = await mkdtemp(join(tmpdir(), "jrnl-conflict-test-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "journal");
  const other = join(root, "other");
  const config = join(root, "config", "jrnl.toml");
  const fakePi = join(root, "fake-pi");
  git(root, ["init", "--bare", remote]);

  await writeFile(fakePi, `#!/bin/sh
cat > memory/TASKS.md <<'EOF'
# Tasks

- Local task
- Remote task
EOF
`, "utf8");
  await chmod(fakePi, 0o755);
  const env = { ...process.env, ...gitIdentity, JRNL_CONFIG_PATH: config };
  assert.equal(run(["init"], env, `${repo}\n${remote}\n${fakePi}\n\n`).status, 0);

  git(root, ["clone", remote, other]);
  await writeFile(join(other, "memory/TASKS.md"), "# Tasks\n\n- Remote task\n");
  git(other, ["add", "memory/TASKS.md"]);
  git(other, ["commit", "-m", "Remote tasks"]);
  git(other, ["push"]);

  await writeFile(join(repo, "memory/TASKS.md"), "# Tasks\n\n- Local task\n");
  git(repo, ["add", "memory/TASKS.md"]);
  git(repo, ["commit", "-m", "Local tasks"]);

  const conflicted = run(["sync"], env);
  assert.equal(conflicted.status, 3);
  assert.match(conflicted.stderr, /resolve-conflicts/);

  const resolved = run(["resolve-conflicts"], env, "y\n");
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.match(resolved.stdout, /Conflicts resolved/);
  const content = await readFile(join(repo, "memory/TASKS.md"), "utf8");
  assert.match(content, /Local task/);
  assert.match(content, /Remote task/);
});

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function run(args, env, input) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    env,
    input,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...gitIdentity },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
