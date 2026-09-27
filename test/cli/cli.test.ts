import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../src/cli/program.js';
import type { Runtime } from '../../src/cli/context.js';
import { startMockApi, type MockApi } from '../fixtures/api-server.js';
import { startHttpMcpServer, type RunningHttpServer } from '../fixtures/http-server.js';
import { fakeBrowser, startMockOAuthServer, type MockOAuthServer } from '../fixtures/oauth-server.js';

const ROOT = resolve(import.meta.dirname, '../..');
const PETSTORE = join(ROOT, 'test/fixtures/petstore.yaml');
const STDIO = ['--', process.execPath, '--import', 'tsx', join(ROOT, 'test/fixtures/stdio-server.ts')];

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function sink(chunks: string[]): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
}

async function makeCli(): Promise<{ home: string; cli: (...argv: string[]) => Promise<Result> }> {
  const home = await mkdtemp(join(tmpdir(), 'anycli-e2e-'));
  const cli = async (...argv: string[]): Promise<Result> => {
    const out: string[] = [];
    const err: string[] = [];
    const runtime: Runtime = {
      io: { stdout: sink(out), stderr: sink(err), stdoutIsTTY: false },
      env: { ...process.env, ANYCLI_HOME: home, ANYCLI_CONFIG: undefined },
      cwd: home,
      openUrl: fakeBrowser,
      readStdin: async () => '{"text":"from stdin"}',
    };
    const code = await run(argv, runtime);
    return { code, stdout: out.join(''), stderr: err.join('') };
  };
  return { home, cli };
}

describe('anycli CLI with a stdio MCP server', () => {
  let cli: (...argv: string[]) => Promise<Result>;
  let home: string;
  beforeAll(async () => {
    ({ cli, home } = await makeCli());
    expect((await cli('add', 'mcp', 'fx', '-d', 'Fixture tools', ...STDIO)).code).toBe(0);
  });

  it('prints help without arguments', async () => {
    const result = await cli();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Quick start');
  });

  it('lists targets and tools', async () => {
    expect((await cli('list')).stdout).toMatch(/fx\s+stdio\s+Fixture tools/);
    const listed = JSON.parse((await cli('--json', 'list')).stdout);
    expect(listed).toEqual([{ name: 'fx', type: 'stdio', description: 'Fixture tools' }]);
    const tools = await cli('tools', 'fx');
    expect(tools.stdout).toContain('add_numbers: Add two numbers\n  --a <number> --b <number>');
    expect((await cli('tools', 'fx', '--names', '--filter', 'ech')).stdout).toBe('echo\n');
    const described = JSON.parse((await cli('--json', 'describe', 'fx', 'echo')).stdout);
    expect(described.inputSchema.required).toEqual(['text']);
  });

  it('calls tools through `call` and the shorthand', async () => {
    expect(await cli('call', 'fx', 'add_numbers', '--a', '2', '--b', '40')).toMatchObject({ code: 0, stdout: '{"sum":42}\n' });
    expect(await cli('fx', 'echo', '--text', 'hi there')).toMatchObject({ code: 0, stdout: 'hi there\n' });
    expect(await cli('fx', 'echo', '--args-file', '-')).toMatchObject({ code: 0, stdout: 'from stdin\n' });
    expect((await cli('--json', 'fx', 'echo', '--text', 'q')).stdout).toBe('"q"\n');
    expect((await cli('fx', 'echo', '--help')).stdout).toContain('--text <string>  (required) Text to echo');
  });

  it('uses distinct exit codes and helpful errors', async () => {
    const missing = await cli('fx', 'add_numbers', '--a', '1');
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('Missing required parameter(s): b');
    const failed = await cli('fx', 'fail');
    expect(failed).toMatchObject({ code: 4, stdout: 'something went wrong\n' });
    const unknown = await cli('nope', 'tool');
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('configured targets: fx');
    const json = await cli('--json', 'call', 'missing-target', 'x');
    expect(JSON.parse(json.stderr).error).toMatchObject({ code: 'NOT_FOUND', message: 'Unknown target "missing-target"' });
    expect((await cli('add', 'mcp', 'fx', 'node')).stderr).toContain('already exists');
    expect((await cli('add', 'mcp', 'list', 'node')).stderr).toContain('reserved');
  });

  it('honors --json and --pretty placed after the tool arguments', async () => {
    expect(await cli('fx', 'echo', '--text', 'q', '--json')).toMatchObject({ code: 0, stdout: '"q"\n' });
    expect((await cli('fx', 'add_numbers', '--a', '1', '--b', '2', '--pretty')).stdout).toBe('{\n  "sum": 3\n}\n');
    const failed = await cli('fx', 'add_numbers', '--a', '1', '--json');
    expect(failed.code).toBe(2);
    expect(JSON.parse(failed.stderr).error).toMatchObject({ code: 'USAGE', message: 'Missing required parameter(s): b' });
    const early = await cli('call', 'missing-target', 'x', '--json');
    expect(JSON.parse(early.stderr).error).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('generates skills and shims', async () => {
    const index = await cli('gen', 'skill');
    expect(index.stdout).toContain('name: anycli\n');
    expect(index.stdout).toContain('**fx** (stdio): Fixture tools');
    const out = await cli('gen', 'skill', 'fx', '--out', 'skills');
    expect(out.code).toBe(0);
    const skill = await readFile(join(home, 'skills', 'anycli-fx', 'SKILL.md'), 'utf8');
    expect(skill).toContain('`anycli call fx add_numbers --a <number> --b <number>`');
    const shim = await cli('gen', 'shim', 'fx', '--dir', 'bin');
    expect(shim.code).toBe(0);
    const shimPath = join(home, 'bin', 'fx');
    expect(await readFile(shimPath, 'utf8')).toContain(`exec "\${ANYCLI_BIN:-anycli}" call 'fx' "$@"`);
    expect((await stat(shimPath)).mode & 0o111).not.toBe(0);
    expect((await cli('gen', 'shim', 'fx', '--dir', 'bin')).code).toBe(2);
  });

  it('checks health with doctor', async () => {
    const doctor = await cli('doctor');
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toMatch(/✓ fx \(stdio\) 4 tools/);
  });
});

describe('anycli CLI with an OpenAPI target', () => {
  let api: MockApi;
  let oauth: MockOAuthServer;
  beforeAll(async () => {
    oauth = await startMockOAuthServer({ clientSecret: 'shh' });
    api = await startMockApi((req) => {
      const token = req.headers.authorization?.replace('Bearer ', '') ?? '';
      if (req.path.startsWith('/oauth') && !oauth.validTokens.has(token)) return { status: 401, body: '{"error":"login"}' };
      return undefined;
    });
    process.env.ANYCLI_TEST_TOKEN = 'tok-123';
  });
  afterAll(async () => {
    await api.close();
    await oauth.close();
    delete process.env.ANYCLI_TEST_TOKEN;
  });

  it('adds a spec with a static token from the environment and calls operations', async () => {
    const { cli, home } = await makeCli();
    const added = await cli('add', 'openapi', 'pets', PETSTORE, '--base-url', api.url, '--bearer', '${ANYCLI_TEST_TOKEN}');
    expect(added.code).toBe(0);
    expect(added.stdout).toContain('9 operations');
    expect(await readFile(join(home, 'config.json'), 'utf8')).not.toContain('tok-123');

    const call = await cli('pets', 'list-pets', '--limit', '3', '--tags', 'a', '--tags', 'b');
    expect(call.code).toBe(0);
    expect(JSON.parse(call.stdout)).toEqual({ method: 'GET', path: '/pets', query: '?limit=3&tags=a&tags=b' });
    expect(api.requests.at(-1)?.headers.authorization).toBe('Bearer tok-123');

    const dry = JSON.parse((await cli('pets', 'create-pet', '--name', 'Rex', '--dry-run')).stdout);
    expect(dry.headers.Authorization).toBe('Bearer ***');
    const shown = (await cli('show', 'pets')).stdout;
    expect(shown).toContain('${ANYCLI_TEST_TOKEN}');
    expect(JSON.parse(shown).spec).toMatchObject({ title: 'Petstore', operations: 9 });
    expect((await cli('refresh', 'pets')).stdout).toContain('9 operations');
  });

  it('logs in with OAuth2 in the browser, calls the API, and logs out', async () => {
    const { cli } = await makeCli();
    const spec = join(await mkdtemp(join(tmpdir(), 'anycli-spec-')), 'oauth.yaml');
    await writeFile(
      spec,
      (await readFile(PETSTORE, 'utf8'))
        .replace('https://auth.example.test/authorize', `${oauth.url}/authorize`)
        .replace('https://auth.example.test/token', `${oauth.url}/token`),
    );
    const added = await cli('add', 'openapi', 'secure', spec, '--base-url', `${api.url}/oauth`, '--oauth', '--client-id', 'cli', '--client-secret', 'shh');
    expect(added.code).toBe(0);
    expect(added.stdout).toContain('Next: anycli auth login secure');
    expect(added.stderr).toContain(`authorization: ${oauth.url}/authorize`);

    expect((await cli('secure', 'list-pets')).code).toBe(3);
    const login = await cli('auth', 'login', 'secure');
    expect(login.code).toBe(0);
    expect(login.stdout).toContain('auto-refresh enabled');
    expect(login.stderr).toContain(`${oauth.url}/authorize?`);
    expect(oauth.lastAuthorizeParams?.get('scope')).toBe('pets:read pets:write');

    const status = JSON.parse((await cli('--json', 'auth', 'status', 'secure')).stdout);
    expect(status[0]).toMatchObject({ target: 'secure', auth: 'oauth2/authorization_code', status: 'logged-in', refreshable: true });
    expect(JSON.stringify(status)).not.toMatch(/at-|rt-/);

    const call = await cli('secure', 'get-pet-by-id', '--pet-id', '7');
    expect(call.code).toBe(0);
    expect(JSON.parse(call.stdout).path).toBe('/oauth/pets/7');

    expect((await cli('auth', 'logout', 'secure')).code).toBe(0);
    const after = await cli('secure', 'list-pets');
    expect(after.code).toBe(3);
    expect(after.stderr).toContain('anycli auth login secure');
  });

  it('pins the base URL from the spec and warns when a refreshed spec points elsewhere', async () => {
    const { cli, home } = await makeCli();
    const spec = join(await mkdtemp(join(tmpdir(), 'anycli-spec-')), 'pets.yaml');
    const original = await readFile(PETSTORE, 'utf8');
    await writeFile(spec, original);
    expect((await cli('add', 'openapi', 'pinned', spec)).code).toBe(0);
    const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    const pinned = config.targets.pinned.baseUrl as string;
    expect(pinned).toMatch(/^https:\/\/petstore\.example\.test\//);

    await writeFile(spec, original.replace('petstore.example.test', 'attacker.example.test'));
    const refreshed = await cli('refresh', 'pinned');
    expect(refreshed.code).toBe(0);
    expect(refreshed.stderr).toContain('attacker.example.test');
    expect(refreshed.stderr).toContain(`requests still go to the configured ${pinned}`);
    const dry = JSON.parse((await cli('pinned', 'list-pets', '--dry-run')).stdout);
    expect(dry.url.startsWith(pinned)).toBe(true);
  });

  it('recompiles a manifest cached by an older anycli version', async () => {
    const { cli, home } = await makeCli();
    expect((await cli('add', 'openapi', 'old', PETSTORE, '--base-url', api.url)).code).toBe(0);
    const cache = join(home, 'cache', 'old.openapi.json');
    const manifest = JSON.parse(await readFile(cache, 'utf8'));
    await writeFile(cache, JSON.stringify({ ...manifest, version: 1, operations: [] }));
    expect((await cli('tools', 'old', '--names')).stdout).toContain('list-pets');
    expect(JSON.parse(await readFile(cache, 'utf8')).version).toBe(2);
  });

  it('requires a client id for OAuth2 and rejects conflicting auth options', async () => {
    const { cli } = await makeCli();
    expect((await cli('add', 'openapi', 'x', PETSTORE, '--oauth')).stderr).toContain('--client-id');
    expect((await cli('add', 'openapi', 'y', PETSTORE, '--bearer', 'a', '--api-key', 'b')).code).toBe(2);
  });
});

describe('anycli CLI with a remote MCP server using MCP OAuth', () => {
  let oauth: MockOAuthServer;
  let mcp: RunningHttpServer;
  beforeAll(async () => {
    oauth = await startMockOAuthServer();
    mcp = await startHttpMcpServer({ oauth: { authServerUrl: oauth.url, isValid: (token) => oauth.validTokens.has(token) } });
  });
  afterAll(async () => {
    await mcp.close();
    await oauth.close();
  });

  it('asks for login, logs in via the browser, then calls tools', async () => {
    const { cli } = await makeCli();
    expect((await cli('add', 'mcp', 'remote', `${mcp.url}/mcp`, '--oauth')).stdout).toContain('Next: anycli auth login remote');
    const before = await cli('remote', 'echo', '--text', 'x');
    expect(before.code).toBe(3);
    expect(before.stderr).toContain('anycli auth login remote');
    const login = await cli('auth', 'login', 'remote');
    expect(login).toMatchObject({ code: 0, stdout: 'Logged in to "remote" (4 tools available)\n' });
    expect(await cli('remote', 'echo', '--text', 'secured')).toMatchObject({ code: 0, stdout: 'secured\n' });
    const status = JSON.parse((await cli('--json', 'auth', 'status')).stdout);
    expect(status[0]).toMatchObject({ target: 'remote', auth: 'mcp-oauth', status: 'logged-in' });
  });
});

describe('import, remove and failures', () => {
  let cli: (...argv: string[]) => Promise<Result>;
  let home: string;
  beforeEach(async () => {
    ({ cli, home } = await makeCli());
  });

  it('imports Claude Desktop style configs', async () => {
    const file = join(home, 'claude_desktop_config.json');
    await writeFile(
      file,
      JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', 'x'] }, web: { url: 'https://example.test/sse' }, bad: {} } }),
    );
    const result = await cli('import', file, '--prefix', 'cd-');
    expect(result.stdout).toContain('Imported 2 target(s): cd-files, cd-web');
    expect(result.stdout).toContain('skipped bad');
    expect((await cli('list')).stdout).toMatch(/cd-web\s+sse/);
    expect((await cli('import', file, '--prefix', 'cd-')).stdout).toContain('already exists');
  });

  it('removes targets', async () => {
    await cli('add', 'mcp', 'gone', 'https://example.test/mcp');
    expect((await cli('rm', 'gone')).code).toBe(0);
    expect((await cli('show', 'gone')).code).toBe(2);
  });

  it('reports unreachable targets in doctor with a non-zero exit code', async () => {
    await cli('add', 'mcp', 'down', 'http://127.0.0.1:1/mcp');
    const doctor = await cli('doctor', 'down');
    expect(doctor.code).toBe(5);
    expect(doctor.stdout).toContain('✗ down (http)');
  });

  it('reports a broken config file', async () => {
    await writeFile(join(home, 'config.json'), '{broken');
    const result = await cli('list');
    expect(result.code).toBe(6);
    expect(result.stderr).toContain('not valid JSON');
  });
});

describe('the real executable', () => {
  it('runs as a process and exits promptly', async () => {
    const home = await mkdtemp(join(tmpdir(), 'anycli-proc-'));
    const exec = promisify(execFile);
    const env = { ...process.env, ANYCLI_HOME: home };
    const bin = [process.execPath, '--import', 'tsx', join(ROOT, 'src/cli.ts')];
    const call = (...args: string[]) => exec(bin[0] as string, [...bin.slice(1), ...args], { env, cwd: ROOT, timeout: 30_000 });
    await call('add', 'mcp', 'fx', ...STDIO);
    const { stdout } = await call('fx', 'add_numbers', '--a', '1', '--b', '2');
    expect(stdout).toBe('{"sum":3}\n');
    const failure = await call('fx', 'fail').catch((error: { code: number; stdout: string }) => error);
    expect(failure).toMatchObject({ code: 4, stdout: 'something went wrong\n' });
  });
});
