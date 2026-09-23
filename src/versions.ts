export const SCHEMA_VERSION = 1;
export const AGENTS_VERSION = 1;

export const REPOSITORY_VERSION_PATH = "state/jrnl.toml";

export function repositoryVersionFile(
  schemaVersion = SCHEMA_VERSION,
  agentsVersion = AGENTS_VERSION,
): string {
  return `schema_version = ${schemaVersion}\nagents_version = ${agentsVersion}\n`;
}
