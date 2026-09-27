import { CliError } from '../core/errors.js';

export interface ConversionResult {
  targets: Record<string, Record<string, unknown>>;
  skipped: Array<{ name: string; reason: string }>;
}

type Entry = Record<string, unknown>;

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(([, v]) => typeof v === 'string') as Array<[string, string]>;
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function convertEntry(entry: Entry): Record<string, unknown> {
  const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : undefined;
  if (typeof entry.command === 'string') {
    const args = asStringArray(entry.args);
    const env = asStringMap(entry.env);
    return {
      type: 'stdio',
      command: entry.command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
    };
  }
  const url = typeof entry.url === 'string' ? entry.url : typeof entry.serverUrl === 'string' ? entry.serverUrl : undefined;
  if (url) {
    const isSse = type === 'sse' || (type === undefined && /\/sse\/?$/.test(url));
    const headers = asStringMap(entry.headers);
    return { type: isSse ? 'sse' : 'http', url, ...(headers ? { headers } : {}) };
  }
  throw new Error('entry has neither "command" nor "url"');
}

/**
 * Converts the `mcpServers` map used by Claude Desktop / Claude Code / Cursor, or the `servers`
 * map used by VS Code, into any2cli targets.
 */
export function convertMcpServers(document: unknown, prefix = ''): ConversionResult {
  const doc = (document ?? {}) as Record<string, unknown>;
  const servers = (doc.mcpServers ?? doc.servers ?? (doc.mcp as Entry | undefined)?.servers) as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== 'object') {
    throw new CliError('USAGE', 'No "mcpServers" or "servers" object found in the file');
  }
  return Object.entries(servers).reduce<ConversionResult>(
    (acc, [name, entry]) => {
      try {
        const converted = convertEntry((entry ?? {}) as Entry);
        return { ...acc, targets: { ...acc.targets, [`${prefix}${name}`]: converted } };
      } catch (error) {
        return { ...acc, skipped: [...acc.skipped, { name, reason: (error as Error).message }] };
      }
    },
    { targets: {}, skipped: [] },
  );
}
