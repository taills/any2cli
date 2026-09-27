import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../../src/core/errors.js';
import { convertMcpServers } from '../../src/config/import-mcp-json.js';
import { resolvePaths } from '../../src/config/paths.js';
import { parseTarget } from '../../src/config/schema.js';
import { getTarget, loadConfig, redactTarget, saveConfig, updateConfig, withTarget, withoutTarget } from '../../src/config/store.js';

describe('resolvePaths', () => {
  it('prefers ANY2CLI_HOME', () => {
    const paths = resolvePaths({ env: { ANY2CLI_HOME: '/h' }, cwd: '/w', exists: () => false });
    expect(paths.home).toBe('/h');
    expect(paths.configFile).toBe('/h/config.json');
    expect(paths.credentialsDir).toBe('/h/credentials');
    expect(paths.cacheDir).toBe('/h/cache');
  });

  it('uses an explicit --config path first, then ANY2CLI_CONFIG, then a project file', () => {
    const base = { env: { ANY2CLI_HOME: '/h', ANY2CLI_CONFIG: '/env.json' }, cwd: '/w' };
    expect(resolvePaths({ ...base, exists: () => true, configOverride: '/flag.json' }).configFile).toBe('/flag.json');
    expect(resolvePaths({ ...base, exists: () => true }).configFile).toBe('/env.json');
    expect(resolvePaths({ env: { ANY2CLI_HOME: '/h' }, cwd: '/w', exists: (p) => p === '/w/.any2cli.json' }).configFile).toBe(
      '/w/.any2cli.json',
    );
  });

  it('falls back to XDG_CONFIG_HOME', () => {
    const paths = resolvePaths({ env: { XDG_CONFIG_HOME: '/x' }, cwd: '/w', exists: () => false });
    expect(paths.home).toBe('/x/any2cli');
  });
});

describe('parseTarget', () => {
  it('accepts every target type', () => {
    expect(parseTarget({ type: 'stdio', command: 'npx', args: ['-y', 'srv'] })).toMatchObject({ type: 'stdio', env: {} });
    expect(parseTarget({ type: 'http', url: 'https://x/mcp' })).toMatchObject({ type: 'http', headers: {} });
    expect(parseTarget({ type: 'sse', url: 'https://x/sse', auth: { type: 'mcp-oauth' } })).toMatchObject({ type: 'sse' });
    expect(
      parseTarget({
        type: 'openapi',
        spec: './a.yaml',
        auth: { type: 'oauth2', clientId: 'c', authorizationUrl: 'https://a', tokenUrl: 'https://t' },
      }),
    ).toMatchObject({ auth: { flow: 'authorization_code', scopes: [], pkce: true } });
  });

  it('rejects invalid targets with a CONFIG error naming the field', () => {
    expect(() => parseTarget({ type: 'stdio' })).toThrow(CliError);
    expect(() => parseTarget({ type: 'stdio' })).toThrow(/command/);
    expect(() => parseTarget({ type: 'weird' })).toThrow(CliError);
    expect(() => parseTarget({ type: 'openapi', spec: 'x', auth: { type: 'apiKey', in: 'body', name: 'k', value: 'v' } })).toThrow(
      CliError,
    );
  });
});

describe('config store', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'any2cli-cfg-'));
  });

  it('returns an empty config when the file is missing', async () => {
    const loaded = await loadConfig(join(dir, 'missing.json'));
    expect(loaded.targets).toEqual({});
  });

  it('saves atomically with 0600 permissions and round-trips', async () => {
    const file = join(dir, 'nested', 'config.json');
    const raw = withTarget({ version: 1, targets: {} }, 'fs', { type: 'stdio', command: 'node', args: ['s.js'] });
    await saveConfig(file, raw);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const loaded = await loadConfig(file);
    expect(getTarget(loaded, 'fs')).toMatchObject({ type: 'stdio', command: 'node' });
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    expect(onDisk.targets.fs).toEqual({ type: 'stdio', command: 'node', args: ['s.js'] });
  });

  it('reports malformed JSON as a CONFIG error', async () => {
    const file = join(dir, 'bad.json');
    await writeFile(file, '{ nope');
    await expect(loadConfig(file)).rejects.toMatchObject({ code: 'CONFIG' });
  });

  it('reports invalid targets with the target name', async () => {
    const file = join(dir, 'invalid.json');
    await writeFile(file, JSON.stringify({ version: 1, targets: { broken: { type: 'http' } } }));
    await expect(loadConfig(file)).rejects.toThrow(/broken/);
  });

  it('adds and removes targets immutably', () => {
    const original = { version: 1 as const, targets: {} };
    const added = withTarget(original, 'a', { type: 'http', url: 'https://x' });
    expect(original.targets).toEqual({});
    expect(Object.keys(added.targets)).toEqual(['a']);
    const removed = withoutTarget(added, 'a');
    expect(removed.targets).toEqual({});
    expect(added.targets).toHaveProperty('a');
  });

  it('suggests known targets when one is missing', async () => {
    const loaded = await loadConfig(join(dir, 'missing.json'));
    try {
      getTarget({ ...loaded, targets: { github: parseTarget({ type: 'http', url: 'https://x' }) } }, 'gh');
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'NOT_FOUND' });
      expect((error as CliError).hint).toContain('github');
    }
  });

  it('redacts secrets when showing a target', () => {
    const shown = redactTarget(
      parseTarget({
        type: 'openapi',
        spec: 's',
        headers: { Authorization: 'Bearer secret', 'X-Trace': 'ok' },
        auth: { type: 'oauth2', clientId: 'c', clientSecret: 'shh', tokenUrl: 'https://t', flow: 'client_credentials' },
      }),
    );
    expect(JSON.stringify(shown)).not.toContain('secret');
    expect(JSON.stringify(shown)).not.toContain('shh');
    expect(JSON.stringify(shown)).toContain('X-Trace');
  });

  it('keeps ${VAR} references visible when redacting', () => {
    const shown = redactTarget(parseTarget({ type: 'http', url: 'https://x', auth: { type: 'bearer', token: '${GH_TOKEN}' } }));
    expect(JSON.stringify(shown)).toContain('${GH_TOKEN}');
  });
});

describe('updateConfig', () => {
  it('does not lose concurrent updates', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'any2cli-upd-')), 'config.json');
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        updateConfig(path, (config) => ({ raw: withTarget(config.raw, `t${index}`, { type: 'http', url: 'https://x.test/mcp' }), result: index })),
      ),
    );
    expect(Object.keys((await loadConfig(path)).targets).sort()).toEqual(['t0', 't1', 't2', 't3', 't4', 't5']);
  });

  it('leaves the config untouched when the update throws', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'any2cli-upd-')), 'config.json');
    await expect(
      updateConfig(path, () => {
        throw new CliError('USAGE', 'nope');
      }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('convertMcpServers', () => {
  it('converts Claude Desktop / Claude Code style configs', () => {
    const result = convertMcpServers({
      mcpServers: {
        fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: { A: '1' } },
        remote: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${T}' } },
        legacy: { url: 'https://y/sse' },
        streamable: { type: 'streamable-http', url: 'https://z/mcp' },
      },
    });
    expect(result.targets.fs).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { A: '1' },
    });
    expect(result.targets.remote).toEqual({ type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${T}' } });
    expect(result.targets.legacy).toMatchObject({ type: 'sse' });
    expect(result.targets.streamable).toMatchObject({ type: 'http' });
    expect(result.skipped).toEqual([]);
  });

  it('converts VS Code style configs and reports skipped entries', () => {
    const result = convertMcpServers({ servers: { ok: { type: 'stdio', command: 'x' }, bad: { foo: 1 } } });
    expect(Object.keys(result.targets)).toEqual(['ok']);
    expect(result.skipped).toEqual([{ name: 'bad', reason: expect.any(String) }]);
  });

  it('applies a prefix and rejects documents without servers', () => {
    expect(Object.keys(convertMcpServers({ mcpServers: { a: { command: 'x' } } }, 'p-').targets)).toEqual(['p-a']);
    expect(() => convertMcpServers({ nothing: true })).toThrow(CliError);
  });
});
