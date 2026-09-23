import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readRepositoryVersions } from "./compatibility.js";
import { loadConfig } from "./config.js";
import { GitConflictError, IncompatibleSchemaError, JrnlError } from "./errors.js";
import { changedPaths, diffStat, git, requireClean, requireGitRepository, restoreClean, syncRepository } from "./git.js";
import { scaffoldJournal } from "./init.js";
import { runResolveConflicts } from "./commands.js";
import { AGENTS_MANAGED_SECTION } from "./prompts.js";
import { confirm, exists, withActivity, writeText } from "./utils.js";
import {
  AGENTS_VERSION,
  REPOSITORY_VERSION_PATH,
  SCHEMA_VERSION,
  repositoryVersionFile,
} from "./versions.js";

interface Migration {
  from: number;
  to: number;
  apply(repo: string): Promise<void>;
}

const migrations: Migration[] = [
  {
    from: 0,
    to: 1,
    apply: async (repo) => {
      await scaffoldJournal(repo);
      await updateManagedAgents(repo);
      await writeText(join(repo, REPOSITORY_VERSION_PATH), repositoryVersionFile(1, AGENTS_VERSION));
    },
  },
];

export async function runUpgrade(migrate: boolean): Promise<void> {
  const config = await loadConfig();
  await withActivity("Checking journal repository", async () => {
    await requireGitRepository(config.repo);
    await requireClean(config.repo);
  });
  await synchronizeForUpgrade();

  const initial = await readRepositoryVersions(config.repo);
  if (initial.schemaVersion > SCHEMA_VERSION) {
    throw new IncompatibleSchemaError(
      `Journal schema ${initial.schemaVersion} requires a newer version of jrnl. Update jrnl before upgrading the repository.`,
    );
  }
  if (initial.agentsVersion > AGENTS_VERSION) {
    throw new JrnlError(
      `Journal agent instructions version ${initial.agentsVersion} is newer than this CLI (${AGENTS_VERSION}). Update jrnl first.`,
    );
  }
  if (initial.schemaVersion < SCHEMA_VERSION && !migrate) {
    throw new IncompatibleSchemaError(
      `Journal schema ${initial.schemaVersion} requires migration to ${SCHEMA_VERSION}. Run \`jrnl upgrade --migrate\`.`,
    );
  }

  let backupBranch: string | undefined;
  let committed = false;
  try {
    await withActivity(migrate ? "Preparing repository migration" : "Preparing repository upgrade", async () => {
      if (migrate && initial.schemaVersion < SCHEMA_VERSION) {
        backupBranch = `jrnl/migration-backup-v${initial.schemaVersion}-${Date.now()}`;
        await git(config.repo, ["branch", backupBranch, "HEAD"]);
        await runMigrations(config.repo, initial.schemaVersion);
      }

      await scaffoldJournal(config.repo);
      await updateManagedAgents(config.repo);
      await writeText(join(config.repo, REPOSITORY_VERSION_PATH), repositoryVersionFile());
    });

    const paths = await changedPaths(config.repo);
    if (paths.length === 0) {
      console.log("Journal repository is already up to date.");
      return;
    }

    console.log(`Upgrade changes:\n${paths.map((path) => `  ${path}`).join("\n")}`);
    const stat = await diffStat(config.repo);
    if (stat) console.log(`\n${stat}`);
    if (backupBranch) console.log(`\nRollback checkpoint: ${backupBranch}`);

    if (!await confirm("Apply, commit, and sync this upgrade?")) {
      await restoreClean(config.repo);
      console.log("Upgrade changes discarded.");
      return;
    }

    await withActivity("Committing upgrade", async () => {
      await git(config.repo, ["add", "-A"]);
      await git(config.repo, ["commit", "-m", migrate ? "jrnl: migrate repository" : "jrnl: upgrade static files"]);
    });
    committed = true;
    await withActivity("Synchronizing upgrade", () => syncRepository(config.repo, {
      beforePush: async () => {
        const versions = await readRepositoryVersions(config.repo);
        if (versions.schemaVersion !== SCHEMA_VERSION) {
          throw new IncompatibleSchemaError("Migration did not produce the expected schema version.");
        }
      },
    }));
    console.log(migrate ? "Journal migrated and synced." : "Journal upgraded and synced.");
  } catch (error) {
    if (!committed) await restoreClean(config.repo);
    throw error;
  }
}

async function synchronizeForUpgrade(): Promise<void> {
  const config = await loadConfig();
  try {
    await withActivity("Synchronizing journal repository", () => syncRepository(config.repo));
  } catch (error) {
    if (!(error instanceof GitConflictError)) throw error;
    console.log("Synchronization conflict detected; resolving before upgrade.");
    await runResolveConflicts(true);
  }
}

async function runMigrations(repo: string, startingVersion: number): Promise<void> {
  let version = startingVersion;
  while (version < SCHEMA_VERSION) {
    const migration = migrations.find((candidate) => candidate.from === version);
    if (!migration) {
      throw new IncompatibleSchemaError(
        `No migration path is available from schema ${version} to ${SCHEMA_VERSION}.`,
      );
    }
    await migration.apply(repo);
    version = migration.to;
  }
}

async function updateManagedAgents(repo: string): Promise<void> {
  const path = join(repo, "AGENTS.md");
  if (!await exists(path)) {
    await writeText(path, `${AGENTS_MANAGED_SECTION}\n\n## Personal Instructions\n\n`);
    return;
  }

  const existing = await readFile(path, "utf8");
  const managedPattern = /<!-- jrnl:managed:start version=\d+ -->[\s\S]*?<!-- jrnl:managed:end -->/;
  if (managedPattern.test(existing)) {
    await writeText(path, existing.replace(managedPattern, AGENTS_MANAGED_SECTION));
    return;
  }

  const preserved = existing.trim();
  await writeText(
    path,
    `${AGENTS_MANAGED_SECTION}\n\n## Personal Instructions\n\n<!-- Preserved from the pre-versioned AGENTS.md -->\n\n${preserved}\n`,
  );
}
