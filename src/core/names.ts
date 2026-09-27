import { CliError } from './errors.js';

const TARGET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Names that would be shadowed by built-in subcommands when used as `anycli <target> <tool>`. */
export const RESERVED_NAMES = new Set([
  'add',
  'auth',
  'call',
  'describe',
  'doctor',
  'gen',
  'help',
  'import',
  'list',
  'ls',
  'refresh',
  'remove',
  'rm',
  'show',
  'tools',
]);

export function assertTargetName(name: string): void {
  if (!TARGET_NAME.test(name) || name.includes('..')) {
    throw new CliError('USAGE', `Invalid target name "${name}"`, {
      hint: 'Use 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit',
    });
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    throw new CliError('USAGE', `Target name "${name}" is reserved`, {
      hint: 'It collides with an anycli subcommand; pick another name',
    });
  }
}

export function toKebabCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

export function normalizeKey(input: string): string {
  return input.replace(/[-_.\s]/g, '').toLowerCase();
}

export function findByName<T extends { name: string }>(items: readonly T[], name: string): T | undefined {
  const exact = items.find((item) => item.name === name);
  if (exact) return exact;
  const wanted = normalizeKey(name);
  return items.find((item) => normalizeKey(item.name) === wanted);
}

export function suggestNames(items: readonly { name: string }[], name: string, limit = 5): string[] {
  const wanted = normalizeKey(name);
  return items
    .map((item) => item.name)
    .filter((candidate) => {
      const normalized = normalizeKey(candidate);
      return normalized.includes(wanted) || wanted.includes(normalized);
    })
    .slice(0, limit);
}
