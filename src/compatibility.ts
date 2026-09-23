import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { IncompatibleSchemaError, JrnlError } from "./errors.js";
import { exists } from "./utils.js";
import { AGENTS_VERSION, REPOSITORY_VERSION_PATH, SCHEMA_VERSION } from "./versions.js";

export interface RepositoryVersions {
  schemaVersion: number;
  agentsVersion: number;
  legacy: boolean;
}

export async function readRepositoryVersions(repo: string): Promise<RepositoryVersions> {
  const path = join(repo, REPOSITORY_VERSION_PATH);
  if (!await exists(path)) return { schemaVersion: 0, agentsVersion: 0, legacy: true };

  let parsed: unknown;
  try {
    parsed = parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new JrnlError(
      `Malformed ${REPOSITORY_VERSION_PATH}: ${(error as Error).message}. Restore it from Git or repair it before running \`jrnl upgrade\`.`,
    );
  }
  if (!isObject(parsed)
    || !isVersion(parsed.schema_version)
    || !isVersion(parsed.agents_version)) {
    throw new JrnlError(
      `Malformed ${REPOSITORY_VERSION_PATH}: schema_version and agents_version must be non-negative integers. `
      + "Restore it from Git or repair it before running `jrnl upgrade`.",
    );
  }
  return {
    schemaVersion: parsed.schema_version,
    agentsVersion: parsed.agents_version,
    legacy: false,
  };
}

export async function requireCompatibleRepository(
  repo: string,
  options: { warnAgents?: boolean } = {},
): Promise<RepositoryVersions> {
  const versions = await readRepositoryVersions(repo);
  if (versions.schemaVersion < SCHEMA_VERSION) {
    throw new IncompatibleSchemaError(
      `Journal schema ${versions.schemaVersion} is older than the supported schema ${SCHEMA_VERSION}. `
      + "Run `jrnl upgrade --migrate`.",
    );
  }
  if (versions.schemaVersion > SCHEMA_VERSION) {
    throw new IncompatibleSchemaError(
      `Journal schema ${versions.schemaVersion} requires a newer version of jrnl. `
      + "Update jrnl, then run `jrnl upgrade --migrate`.",
    );
  }

  if (options.warnAgents !== false && versions.agentsVersion !== AGENTS_VERSION) {
    const direction = versions.agentsVersion < AGENTS_VERSION ? "outdated" : "newer than this CLI";
    console.error(
      `Warning: journal agent instructions are ${direction} `
      + `(${versions.agentsVersion} vs ${AGENTS_VERSION}). Run \`jrnl upgrade\`.`,
    );
  }
  return versions;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
