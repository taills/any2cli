import { readFile } from 'node:fs/promises';
import { CliError } from './errors.js';
import { normalizeKey } from './names.js';
import type { JsonSchema } from './types.js';

export type ArgPair = [key: string, value: string | boolean];

export interface ReservedOptions {
  argsJson?: string;
  argsFile?: string;
  raw: boolean;
  dryRun: boolean;
  timeoutMs?: number;
  save?: string;
  help: boolean;
}

export interface ParsedTokens {
  pairs: ArgPair[];
  reserved: ReservedOptions;
}

/** Options consumed by any2cli itself; every other `--flag` is forwarded to the tool. */
export const RESERVED_FLAGS = ['--args', '--args-file', '--raw', '--dry-run', '--call-timeout', '--save', '--help', '-h'];

const VALUE_FLAGS = new Set(['args', 'args-file', 'call-timeout', 'save']);

function looksLikeValue(token: string | undefined): token is string {
  return token !== undefined && (!token.startsWith('-') || /^-\d/.test(token));
}

function applyReserved(reserved: ReservedOptions, key: string, value: string | true): ReservedOptions {
  switch (key) {
    case 'raw':
      return { ...reserved, raw: true };
    case 'dry-run':
      return { ...reserved, dryRun: true };
    case 'help':
      return { ...reserved, help: true };
    case 'args':
      return { ...reserved, argsJson: String(value) };
    case 'args-file':
      return { ...reserved, argsFile: String(value) };
    case 'save':
      return { ...reserved, save: String(value) };
    default: {
      const timeoutMs = Number(value);
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new CliError('USAGE', `--call-timeout expects a positive integer (milliseconds), got "${value}"`);
      }
      return { ...reserved, timeoutMs };
    }
  }
}

const RESERVED_KEYS = new Set(['raw', 'dry-run', 'help', 'args', 'args-file', 'save', 'call-timeout']);

/** Splits raw argv tokens after `<target> <tool>` into tool arguments and any2cli's own options. */
export function parseToolTokens(tokens: readonly string[]): ParsedTokens {
  let reserved: ReservedOptions = { raw: false, dryRun: false, help: false };
  const pairs: ArgPair[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (token === '-h') {
      reserved = { ...reserved, help: true };
      continue;
    }
    if (token === '-v') {
      pairs.push(['verbose', true]);
      continue;
    }
    if (!token.startsWith('--') || token === '--') {
      throw new CliError('USAGE', `Unexpected argument "${token}"`, {
        hint: 'Pass tool parameters as --name value, or a JSON object with --args \'{...}\'',
      });
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    const key = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? undefined : body.slice(eq + 1);
    const next = tokens[index + 1];

    if (RESERVED_KEYS.has(key)) {
      if (VALUE_FLAGS.has(key)) {
        const value = inline ?? (next !== undefined && next !== '--' ? next : undefined);
        if (value === undefined) throw new CliError('USAGE', `--${key} requires a value`);
        if (inline === undefined) index += 1;
        reserved = applyReserved(reserved, key, value);
      } else {
        reserved = applyReserved(reserved, key, true);
      }
      continue;
    }
    if (inline !== undefined) {
      pairs.push([key, inline]);
    } else if (looksLikeValue(next)) {
      pairs.push([key, next]);
      index += 1;
    } else {
      pairs.push([key, true]);
    }
  }
  return { pairs, reserved };
}

/** any2cli's global flags that users (and agents) often append after the tool arguments. */
export const TRAILING_GLOBAL_KEYS = ['json', 'pretty', 'verbose'] as const;
export type TrailingGlobal = (typeof TRAILING_GLOBAL_KEYS)[number];

/**
 * Separates a bare `--json` / `--pretty` / `--verbose` from the tool arguments. They belong to
 * any2cli unless the tool itself declares a parameter with that name.
 */
export function splitGlobalFlags(pairs: readonly ArgPair[], schema?: JsonSchema): { pairs: ArgPair[]; globals: TrailingGlobal[] } {
  const properties = schema?.properties ?? {};
  const isGlobal = ([key, value]: ArgPair): boolean =>
    value === true && (TRAILING_GLOBAL_KEYS as readonly string[]).includes(key) && resolveKey(key, properties) === undefined;
  return {
    pairs: pairs.filter((pair) => !isGlobal(pair)),
    globals: [...new Set(pairs.filter(isGlobal).map(([key]) => key as TrailingGlobal))],
  };
}

function schemaTypes(schema: JsonSchema): string[] {
  if (Array.isArray(schema.type)) return schema.type;
  if (typeof schema.type === 'string') return [schema.type];
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) return variants.flatMap(schemaTypes);
  if (schema.allOf) return schema.allOf.flatMap(schemaTypes);
  if (schema.properties) return ['object'];
  if (schema.items) return ['array'];
  return [];
}

function primaryType(schema: JsonSchema): string | undefined {
  return schemaTypes(schema).find((type) => type !== 'null');
}

function parseJsonValue(name: string, value: string, expected: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new CliError('USAGE', `Parameter "${name}" expects ${expected} as JSON, got "${value}"`);
  }
}

function coerceScalar(name: string, value: string | boolean, schema: JsonSchema): unknown {
  const type = primaryType(schema);
  if (value === true || value === false) {
    if (type === 'boolean' || type === undefined) return value;
    throw new CliError('USAGE', `Parameter "${name}" requires a value (${type})`);
  }
  switch (type) {
    case 'integer':
    case 'number': {
      const parsed = Number(value);
      if (value.trim() === '' || Number.isNaN(parsed) || (type === 'integer' && !Number.isInteger(parsed))) {
        throw new CliError('USAGE', `Parameter "${name}" expects an ${type}, got "${value}"`);
      }
      return parsed;
    }
    case 'boolean': {
      const lowered = value.toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(lowered)) return true;
      if (['false', '0', 'no', 'n'].includes(lowered)) return false;
      throw new CliError('USAGE', `Parameter "${name}" expects a boolean (true/false), got "${value}"`);
    }
    case 'object':
      return parseJsonValue(name, value, 'an object');
    case 'array':
      return value.trim().startsWith('[') ? parseJsonValue(name, value, 'an array') : [coerceScalar(name, value, schema.items ?? {})];
    case 'string':
      return value;
    default: {
      const trimmed = value.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return JSON.parse(trimmed);
        } catch {
          return value;
        }
      }
      return value;
    }
  }
}

function coerceValues(name: string, values: Array<string | boolean>, schema: JsonSchema): unknown {
  if (primaryType(schema) === 'array') {
    if (values.length === 1) return coerceScalar(name, values[0] as string | boolean, schema);
    return values.map((value) => coerceScalar(name, value, schema.items ?? {}));
  }
  return coerceScalar(name, values[values.length - 1] as string | boolean, schema);
}

function checkEnum(name: string, value: unknown, schema: JsonSchema): void {
  if (!schema.enum || schema.enum.length === 0) return;
  const values = Array.isArray(value) ? value : [value];
  const allowed = schema.enum;
  const itemsEnum = primaryType(schema) === 'array' ? schema.items?.enum : undefined;
  const pool = itemsEnum ?? allowed;
  if (values.some((item) => !pool.includes(item))) {
    throw new CliError('USAGE', `Parameter "${name}" must be one of: ${pool.map(String).join(', ')}`);
  }
}

function resolveKey(key: string, properties: Record<string, JsonSchema>): string | undefined {
  if (key in properties) return key;
  const wanted = normalizeKey(key);
  return Object.keys(properties).find((candidate) => normalizeKey(candidate) === wanted);
}

/** Maps a flag to a schema property; a bare `--no-foo` means `foo=false` unless `no-foo` itself exists. */
function resolvePair([key, value]: ArgPair, properties: Record<string, JsonSchema>, allowsExtra: boolean): ArgPair {
  const direct = resolveKey(key, properties);
  if (direct !== undefined) return [direct, value];
  const negated = value === true && key.startsWith('no-') && key.length > 3 ? key.slice(3) : undefined;
  const positive = negated === undefined ? undefined : resolveKey(negated, properties);
  if (positive !== undefined) return [positive, false];
  if (!allowsExtra) {
    const known = Object.keys(properties);
    throw new CliError('USAGE', `Unknown parameter "${key}"`, {
      hint: known.length > 0 ? `Available parameters: ${known.join(', ')}` : 'This tool takes no parameters',
    });
  }
  return negated === undefined ? [key, value] : [negated, false];
}

async function loadBaseArgs(reserved: ReservedOptions, readStdin: () => Promise<string>): Promise<Record<string, unknown>> {
  let text: string | undefined;
  let source = '--args';
  if (reserved.argsFile !== undefined) {
    source = '--args-file';
    text = reserved.argsFile === '-' ? await readStdin() : await readArgsFile(reserved.argsFile);
  } else if (reserved.argsJson !== undefined) {
    text = reserved.argsJson;
  }
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliError('USAGE', `${source} is not valid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('USAGE', `${source} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

async function readArgsFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new CliError('USAGE', `Cannot read --args-file ${path}: ${(error as Error).message}`);
  }
}

export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

export interface BuildArgsInput extends ParsedTokens {
  schema: JsonSchema;
  readStdin?: () => Promise<string>;
}

/** Turns parsed flags (plus optional JSON input) into a validated argument object for the tool. */
export async function buildToolArgs(input: BuildArgsInput): Promise<Record<string, unknown>> {
  const properties = input.schema.properties ?? {};
  const allowsExtra = input.schema.additionalProperties !== false;
  const base = await loadBaseArgs(input.reserved, input.readStdin ?? readAllStdin);

  const grouped = input.pairs.reduce<Map<string, Array<string | boolean>>>((acc, pair) => {
    const [name, value] = resolvePair(pair, properties, allowsExtra);
    return new Map(acc).set(name, [...(acc.get(name) ?? []), value]);
  }, new Map());

  const fromFlags = Object.fromEntries(
    [...grouped.entries()].map(([name, values]) => {
      const schema = properties[name] ?? {};
      const value = coerceValues(name, values, schema);
      checkEnum(name, value, schema);
      return [name, value];
    }),
  );

  const args = { ...base, ...fromFlags };
  const missing = (input.schema.required ?? []).filter((name) => args[name] === undefined);
  if (missing.length > 0) {
    throw new CliError('USAGE', `Missing required parameter(s): ${missing.join(', ')}`, {
      hint: 'Run with --help to see the tool signature',
    });
  }
  return args;
}
