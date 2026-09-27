import { CliError } from './errors.js';

type Env = Record<string, string | undefined>;

const PATTERN = /\$(\$?)\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Expands `${VAR}`, `${env:VAR}` and `${VAR:-default}` references so secrets can live in the
 * environment instead of the config file. `$${VAR}` is an escape for a literal `${VAR}`.
 */
export function interpolate(value: string, env: Env = process.env): string {
  return value.replace(PATTERN, (match, escape: string, name: string, fallback: string | undefined) => {
    if (escape) return match.slice(1);
    const resolved = env[name];
    if (resolved !== undefined) return resolved;
    if (fallback !== undefined) return fallback;
    throw new CliError('CONFIG', `Environment variable ${name} is not set`, {
      hint: `export ${name}=... before running, or use \${${name}:-default} in the config`,
    });
  });
}

export function interpolateDeep<T>(value: T, env: Env = process.env): T {
  if (typeof value === 'string') return interpolate(value, env) as T;
  if (Array.isArray(value)) return value.map((item) => interpolateDeep(item, env)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, interpolateDeep(item, env)]),
    ) as T;
  }
  return value;
}
