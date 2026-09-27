import { readFile } from 'node:fs/promises';
import { CliError } from '../core/errors.js';
import { isNotFound, withFileLock, writeFileAtomic } from '../core/fs.js';
import { suggestNames } from '../core/names.js';
import { parseTarget, type Target } from './schema.js';

export interface RawConfig {
  version: 1;
  targets: Record<string, unknown>;
}

export interface LoadedConfig {
  path: string;
  raw: RawConfig;
  targets: Record<string, Target>;
}

const EMPTY: RawConfig = { version: 1, targets: {} };

async function readRaw(path: string): Promise<RawConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return EMPTY;
    throw new CliError('CONFIG', `Cannot read config ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliError('CONFIG', `Config ${path} is not valid JSON: ${(error as Error).message}`);
  }
  const targets = (parsed as { targets?: unknown } | null)?.targets ?? {};
  if (typeof targets !== 'object' || targets === null || Array.isArray(targets)) {
    throw new CliError('CONFIG', `Config ${path}: "targets" must be an object`);
  }
  return { version: 1, targets: targets as Record<string, unknown> };
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const raw = await readRaw(path);
  const targets = Object.fromEntries(Object.entries(raw.targets).map(([name, value]) => [name, parseTarget(value, name)]));
  return { path, raw, targets };
}

export async function saveConfig(path: string, raw: RawConfig): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(raw, null, 2)}\n`);
}

export interface ConfigUpdate<T> {
  raw: RawConfig;
  result: T;
}

/**
 * Read-modify-write of the config under a lock file, so concurrent `any2cli add`/`import` runs
 * (e.g. an agent setting up several targets at once) don't drop each other's changes.
 */
export async function updateConfig<T>(path: string, fn: (config: LoadedConfig) => ConfigUpdate<T> | Promise<ConfigUpdate<T>>): Promise<T> {
  return withFileLock(`${path}.lock`, async () => {
    const { raw, result } = await fn(await loadConfig(path));
    await saveConfig(path, raw);
    return result;
  });
}

export function getTarget(config: Pick<LoadedConfig, 'targets'>, name: string): Target {
  const target = config.targets[name];
  if (target) return target;
  const known = Object.keys(config.targets).map((key) => ({ name: key }));
  const similar = suggestNames(known, name);
  const hint =
    known.length === 0
      ? 'No targets configured yet. Add one with `any2cli add mcp ...` or `any2cli add openapi ...`'
      : `Known targets: ${(similar.length > 0 ? similar : known.map((item) => item.name)).join(', ')}`;
  throw new CliError('NOT_FOUND', `Unknown target "${name}"`, { hint });
}

export function withTarget(raw: RawConfig, name: string, target: unknown): RawConfig {
  return { ...raw, targets: { ...raw.targets, [name]: target } };
}

export function withoutTarget(raw: RawConfig, name: string): RawConfig {
  const { [name]: _removed, ...rest } = raw.targets;
  return { ...raw, targets: rest };
}

const SECRET_KEY = /secret|password|token|value|authorization|cookie|api[-_]?key/i;
const MASK = '***';

function redactValue(key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    if (!SECRET_KEY.test(key) || value.includes('${')) return value;
    return MASK;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(key, item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(k, v)]));
  }
  return value;
}

/** Returns a copy safe to print: literal secrets are masked, `${ENV}` references stay visible. */
export function redactTarget(target: Target): Record<string, unknown> {
  return redactValue('', target) as Record<string, unknown>;
}
