import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildToolArgs, parseToolTokens, splitGlobalFlags } from '../../src/core/args.js';
import { CliError } from '../../src/core/errors.js';
import { renderSignature, renderToolHelp, typeLabel } from '../../src/core/schema-sig.js';
import type { JsonSchema, ToolDescriptor } from '../../src/core/types.js';

const schema: JsonSchema = {
  type: 'object',
  properties: {
    petId: { type: 'integer', description: 'Pet id' },
    name: { type: 'string' },
    ratio: { type: 'number' },
    verbose: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    ids: { type: 'array', items: { type: 'integer' } },
    filter: { type: 'object' },
    nullableCount: { anyOf: [{ type: 'null' }, { type: 'integer' }] },
    status: { type: 'string', enum: ['available', 'sold'] },
    anything: {},
  },
  required: ['petId'],
  additionalProperties: false,
};

describe('parseToolTokens', () => {
  it('separates reserved options from tool arguments', () => {
    const parsed = parseToolTokens([
      '--pet-id',
      '7',
      '--name=Rex',
      '--verbose',
      '--no-debug',
      '--tags',
      'a',
      '--tags',
      'b',
      '--raw',
      '--dry-run',
      '--call-timeout',
      '5000',
      '--save',
      'out.bin',
    ]);
    expect(parsed.pairs).toEqual([
      ['pet-id', '7'],
      ['name', 'Rex'],
      ['verbose', true],
      ['no-debug', true],
      ['tags', 'a'],
      ['tags', 'b'],
    ]);
    expect(parsed.reserved).toEqual({ raw: true, dryRun: true, timeoutMs: 5000, save: 'out.bin', help: false });
  });

  it('treats negative numbers as values', () => {
    expect(parseToolTokens(['--ratio', '-1.5']).pairs).toEqual([['ratio', '-1.5']]);
  });

  it('captures --args, --args-file and help', () => {
    const parsed = parseToolTokens(['--args', '{"a":1}', '--args-file', 'x.json', '-h']);
    expect(parsed.reserved).toMatchObject({ argsJson: '{"a":1}', argsFile: 'x.json', help: true });
  });

  it('rejects positional arguments and bad timeouts', () => {
    expect(() => parseToolTokens(['oops'])).toThrow(CliError);
    expect(() => parseToolTokens(['--call-timeout', 'soon'])).toThrow(/call-timeout/);
    expect(() => parseToolTokens(['--args'])).toThrow(/--args/);
  });
});

describe('buildToolArgs', () => {
  it('coerces values according to the schema and matches keys tolerantly', async () => {
    const { pairs, reserved } = parseToolTokens([
      '--pet-id',
      '7',
      '--ratio',
      '0.5',
      '--verbose',
      'false',
      '--tags',
      'a',
      '--tags',
      'b',
      '--ids',
      '[1,2]',
      '--filter',
      '{"q":"x"}',
      '--nullable-count',
      '3',
      '--anything',
      '{"k":[1]}',
    ]);
    const args = await buildToolArgs({ pairs, reserved, schema });
    expect(args).toEqual({
      petId: 7,
      ratio: 0.5,
      verbose: false,
      tags: ['a', 'b'],
      ids: [1, 2],
      filter: { q: 'x' },
      nullableCount: 3,
      anything: { k: [1] },
    });
  });

  it('wraps a single value into an array', async () => {
    const args = await buildToolArgs({ ...parseToolTokens(['--pet-id', '1', '--ids', '5']), schema });
    expect(args.ids).toEqual([5]);
  });

  it('merges --args JSON with flags, flags winning', async () => {
    const args = await buildToolArgs({ ...parseToolTokens(['--args', '{"petId":1,"name":"a"}', '--name', 'b']), schema });
    expect(args).toEqual({ petId: 1, name: 'b' });
  });

  it('reads --args-file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'any2cli-args-'));
    const file = join(dir, 'args.json');
    await writeFile(file, JSON.stringify({ petId: 9 }));
    const args = await buildToolArgs({ ...parseToolTokens(['--args-file', file]), schema });
    expect(args).toEqual({ petId: 9 });
  });

  it('reads --args-file - from stdin', async () => {
    const args = await buildToolArgs({
      ...parseToolTokens(['--args-file', '-']),
      schema,
      readStdin: async () => '{"petId":3}',
    });
    expect(args).toEqual({ petId: 3 });
  });

  it('reports invalid values, unknown and missing parameters as USAGE errors', async () => {
    await expect(buildToolArgs({ ...parseToolTokens(['--pet-id', 'abc']), schema })).rejects.toThrow(/petId.*integer/);
    await expect(buildToolArgs({ ...parseToolTokens(['--pet-id', '1', '--verbose', 'maybe']), schema })).rejects.toThrow(
      /boolean/,
    );
    await expect(buildToolArgs({ ...parseToolTokens(['--pet-id', '1', '--colour', 'red']), schema })).rejects.toThrow(
      /Unknown parameter "colour"/,
    );
    await expect(buildToolArgs({ ...parseToolTokens(['--name', 'x']), schema })).rejects.toThrow(/Missing required.*petId/);
    await expect(buildToolArgs({ ...parseToolTokens(['--pet-id', '1', '--filter', 'x']), schema })).rejects.toThrow(/JSON/);
    await expect(buildToolArgs({ ...parseToolTokens(['--args', '[1]']), schema })).rejects.toThrow(/object/);
    await expect(buildToolArgs({ ...parseToolTokens(['--pet-id', '1', '--status', 'lost']), schema })).rejects.toThrow(
      /available, sold/,
    );
  });

  it('passes unknown keys through when the schema allows extra properties', async () => {
    const args = await buildToolArgs({ ...parseToolTokens(['--whatever', 'x']), schema: { type: 'object' } });
    expect(args).toEqual({ whatever: 'x' });
  });

  it('rejects a bare flag for a string parameter', async () => {
    await expect(buildToolArgs({ ...parseToolTokens(['--pet-id', '1', '--name']), schema })).rejects.toThrow(/requires a value/);
  });

  it('treats --no-foo as foo=false only when the schema has no no-foo parameter', async () => {
    expect(await buildToolArgs({ ...parseToolTokens(['--pet-id', '1', '--no-verbose']), schema })).toEqual({ petId: 1, verbose: false });
    const withNo: JsonSchema = { type: 'object', properties: { 'no-cache': { type: 'boolean' }, cache: { type: 'boolean' } } };
    expect(await buildToolArgs({ ...parseToolTokens(['--no-cache']), schema: withNo })).toEqual({ 'no-cache': true });
    expect(await buildToolArgs({ ...parseToolTokens(['--no-color']), schema: { type: 'object' } })).toEqual({ color: false });
    await expect(buildToolArgs({ ...parseToolTokens(['--pet-id', '1', '--no-such']), schema })).rejects.toThrow(/Unknown parameter "no-such"/);
  });
});

describe('splitGlobalFlags', () => {
  it('takes trailing --json/--pretty/--verbose/-v for any2cli unless the tool declares them', () => {
    const { pairs } = parseToolTokens(['--q', 'x', '--json', '-v', '--pretty', '--json']);
    expect(splitGlobalFlags(pairs)).toEqual({ pairs: [['q', 'x']], globals: ['json', 'verbose', 'pretty'] });
    expect(splitGlobalFlags(pairs, schema)).toEqual({
      pairs: [['q', 'x'], ['verbose', true]],
      globals: ['json', 'pretty'],
    });
  });

  it('keeps --json with a value as a tool parameter', () => {
    const { pairs } = parseToolTokens(['--json', '{"a":1}']);
    expect(splitGlobalFlags(pairs)).toEqual({ pairs: [['json', '{"a":1}']], globals: [] });
  });
});

describe('schema signatures', () => {
  const tool: ToolDescriptor = {
    name: 'update-pet',
    description: 'Update a pet.\nSecond line.',
    inputSchema: schema,
  };

  it('labels types', () => {
    expect(typeLabel({ type: 'string', enum: ['a', 'b'] })).toBe('a|b');
    expect(typeLabel({ type: 'array', items: { type: 'integer' } })).toBe('integer[]');
    expect(typeLabel({ type: 'object' })).toBe('json');
    expect(typeLabel({ anyOf: [{ type: 'null' }, { type: 'number' }] })).toBe('number');
    expect(typeLabel({})).toBe('value');
  });

  it('renders a one-line signature with required params first', () => {
    const sig = renderSignature(tool);
    expect(sig.startsWith('update-pet --petId <integer> [--name <string>]')).toBe(true);
    expect(sig).toContain('[--verbose]');
  });

  it('renders detailed help', () => {
    const help = renderToolHelp(tool, 'any2cli call pets');
    expect(help).toContain('Update a pet.');
    expect(help).toContain('any2cli call pets update-pet --petId <integer>');
    expect(help).toMatch(/--petId <integer>\s+\(required\) Pet id/);
    expect(help).toContain('--status <available|sold>');
  });
});
