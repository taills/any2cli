import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTarget, type OpenApiTarget } from '../../src/config/schema.js';
import { openOpenApiAdapter } from '../../src/openapi/adapter.js';
import { compileSpec, MANIFEST_VERSION, type CompileOptions, type OpenApiManifest } from '../../src/openapi/compile.js';
import { loadSpec } from '../../src/openapi/load.js';
import { readManifest, writeManifest } from '../../src/openapi/manifest-store.js';
import { buildRequest } from '../../src/openapi/request.js';
import { startMockApi, type MockApi } from '../fixtures/api-server.js';

const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const PETSTORE = join(FIXTURES, 'petstore.yaml');

async function petstore(options: Omit<CompileOptions, 'source'> = {}): Promise<OpenApiManifest> {
  return compileSpec(await loadSpec(PETSTORE), { source: PETSTORE, ...options });
}

function op(manifest: OpenApiManifest, name: string) {
  const found = manifest.operations.find((operation) => operation.name === name);
  if (!found) throw new Error(`no operation ${name}`);
  return found;
}

describe('compileSpec', () => {
  it('turns every operation into a kebab-case tool', async () => {
    const manifest = await petstore();
    expect(manifest.title).toBe('Petstore');
    expect(manifest.baseUrl).toBe('https://petstore.example.test/v1');
    expect(manifest.operations.map((operation) => operation.name)).toEqual([
      'list-pets',
      'create-pet',
      'get-pet-by-id',
      'delete-pets-pet-id',
      'upload-photo',
      'search',
      'bulk-search',
      'login',
      'download',
    ]);
  });

  it('maps parameters of all locations into the input schema', async () => {
    const listPets = op(await petstore(), 'list-pets');
    expect(listPets.method).toBe('GET');
    expect(Object.keys(listPets.inputSchema.properties ?? {})).toEqual(['limit', 'tags', 'X-Request-Id', 'session']);
    expect(listPets.inputSchema.properties?.limit).toMatchObject({ type: 'integer', description: 'How many items to return' });
    expect(listPets.params.map((param) => param.in)).toEqual(['query', 'query', 'header', 'cookie']);
  });

  it('merges path-level parameters and marks them required', async () => {
    const getPet = op(await petstore(), 'get-pet-by-id');
    expect(getPet.inputSchema.required).toEqual(['petId']);
    expect(getPet.params[0]).toMatchObject({ name: 'petId', in: 'path', required: true });
  });

  it('flattens object request bodies and neutralizes circular references', async () => {
    const createPet = op(await petstore(), 'create-pet');
    expect(createPet.body).toMatchObject({ mode: 'flat', contentType: 'application/json', props: ['id', 'name', 'tag', 'owner'] });
    expect(createPet.inputSchema.required).toEqual(['name']);
    expect(JSON.stringify(createPet.inputSchema)).not.toContain('$ref');
  });

  it('keeps non-object bodies as a single "body" parameter', async () => {
    const bulk = op(await petstore(), 'bulk-search');
    expect(bulk.body).toMatchObject({ mode: 'raw', arg: 'body' });
    expect(bulk.inputSchema.required).toEqual(['body']);
    expect(bulk.inputSchema.properties?.body).toMatchObject({ type: 'array' });
  });

  it('supports include/exclude filters by name, operationId and tag', async () => {
    expect((await petstore({ include: ['tag:pets'] })).operations.map((o) => o.name)).toEqual([
      'list-pets',
      'create-pet',
      'get-pet-by-id',
    ]);
    expect((await petstore({ exclude: ['tag:pets', 'search*', 'bulkSearch'] })).operations.map((o) => o.name)).toEqual([
      'delete-pets-pet-id',
      'upload-photo',
      'login',
      'download',
    ]);
  });

  it('extracts security schemes for auth setup', async () => {
    const manifest = await petstore();
    expect(manifest.security).toEqual([
      {
        name: 'petAuth',
        type: 'oauth2',
        flow: 'authorization_code',
        authorizationUrl: 'https://auth.example.test/authorize',
        tokenUrl: 'https://auth.example.test/token',
        scopes: ['pets:read', 'pets:write'],
      },
      { name: 'apiKey', type: 'apiKey', in: 'header', paramName: 'X-API-Key' },
    ]);
  });

  it('converts Swagger 2.0 documents', async () => {
    const source = join(FIXTURES, 'swagger2.json');
    const manifest = compileSpec(await loadSpec(source), { source });
    expect(manifest.baseUrl).toBe('https://legacy.example.test/api');
    expect(manifest.operations.map((operation) => operation.name)).toEqual(['get-user', 'create-user']);
    expect(op(manifest, 'create-user').inputSchema.required).toEqual(['email']);
    expect(manifest.security[0]).toMatchObject({ type: 'oauth2', flow: 'authorization_code' });
  });

  it('resolves relative server URLs against a remote spec URL', () => {
    const manifest = compileSpec(
      { openapi: '3.0.0', info: { title: 't', version: '1' }, servers: [{ url: '/api/v2' }], paths: {} },
      { source: 'https://docs.example.test/openapi.json' },
    );
    expect(manifest.baseUrl).toBe('https://docs.example.test/api/v2');
  });

  it('reports unreadable specs as CONFIG errors', async () => {
    await expect(loadSpec(join(FIXTURES, 'does-not-exist.yaml'))).rejects.toMatchObject({ code: 'CONFIG' });
  });

  it('round-trips the manifest cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anycli-manifest-'));
    const manifest = await petstore();
    await writeManifest(dir, 'pets', manifest);
    expect(await readManifest(dir, 'pets')).toEqual(manifest);
    await expect(readManifest(dir, 'nope')).resolves.toBeUndefined();
  });
});

describe('loadSpec over HTTP', () => {
  it('loads a YAML spec from a local dev server and resolves its relative server URL', async () => {
    const yaml = (await readFile(PETSTORE, 'utf8')).replace("'{scheme}://petstore.example.test/{basePath}'", '/api/v1');
    const server = await startMockApi(() => ({ headers: { 'content-type': 'application/yaml' }, body: yaml }));
    try {
      const source = `${server.url}/openapi.yaml`;
      const manifest = compileSpec(await loadSpec(source), { source });
      expect(manifest.operations).toHaveLength(9);
      expect(manifest.baseUrl).toBe(`${server.url}/api/v1`);
    } finally {
      await server.close();
    }
  });
});

describe('buildRequest', () => {
  it('encodes path, query arrays, headers and cookies', async () => {
    const manifest = await petstore();
    const request = await buildRequest(op(manifest, 'list-pets'), {
      baseUrl: 'https://api.test/v1/',
      args: { limit: 5, tags: ['a b', 'c'], 'X-Request-Id': 'r1', session: 'abc' },
    });
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://api.test/v1/pets?limit=5&tags=a+b&tags=c');
    expect(request.headers).toMatchObject({ 'X-Request-Id': 'r1', Cookie: 'session=abc' });
  });

  it('encodes deepObject query parameters and path parameters safely', async () => {
    const manifest = await petstore();
    const search = await buildRequest(op(manifest, 'search'), { baseUrl: 'https://api.test', args: { filter: { status: 'sold' } } });
    expect(search.url).toBe('https://api.test/search?filter%5Bstatus%5D=sold');
    const get = await buildRequest(op(manifest, 'get-pet-by-id'), { baseUrl: 'https://api.test', args: { petId: '../x' } });
    expect(get.url).toBe('https://api.test/pets/..%2Fx');
  });

  it('builds JSON, form and multipart bodies', async () => {
    const manifest = await petstore();
    const create = await buildRequest(op(manifest, 'create-pet'), { baseUrl: 'https://api.test', args: { name: 'Rex', tag: 'dog' } });
    expect(create.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(create.body as string)).toEqual({ name: 'Rex', tag: 'dog' });

    const login = await buildRequest(op(manifest, 'login'), { baseUrl: 'https://api.test', args: { username: 'u', password: 'p w' } });
    expect(login.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(String(login.body)).toBe('username=u&password=p+w');

    const dir = await mkdtemp(join(tmpdir(), 'anycli-upload-'));
    const file = join(dir, 'cat.png');
    await writeFile(file, 'meow');
    const upload = await buildRequest(op(manifest, 'upload-photo'), {
      baseUrl: 'https://api.test',
      args: { petId: 1, file: `@${file}`, caption: 'hi' },
    });
    const form = upload.body as FormData;
    expect(form.get('caption')).toBe('hi');
    expect(await (form.get('file') as File).text()).toBe('meow');
    expect((form.get('file') as File).name).toBe('cat.png');
    expect(upload.headers['Content-Type']).toBeUndefined();
  });

  it('adds auth headers and query parameters', async () => {
    const manifest = await petstore();
    const request = await buildRequest(op(manifest, 'download'), {
      baseUrl: 'https://api.test',
      args: {},
      auth: { headers: { Authorization: 'Bearer t' }, query: { api_key: 'k' } },
      headers: { 'X-Extra': '1' },
    });
    expect(request.url).toBe('https://api.test/download?api_key=k');
    expect(request.headers).toMatchObject({ Authorization: 'Bearer t', 'X-Extra': '1' });
  });

  it('reads @file only for binary fields and never from protected directories', async () => {
    const manifest = await petstore();
    expect(manifest.version).toBe(MANIFEST_VERSION);
    expect(op(manifest, 'upload-photo').body?.fileArgs).toEqual(['file']);
    const dir = await mkdtemp(join(tmpdir(), 'anycli-upload-'));
    const request = await buildRequest(op(manifest, 'upload-photo'), {
      baseUrl: 'https://api.test',
      args: { petId: 1, caption: '@not-a-file' },
    });
    expect((request.body as FormData).get('caption')).toBe('@not-a-file');
    const json = await buildRequest(op(manifest, 'create-pet'), { baseUrl: 'https://api.test', args: { name: '@rex' } });
    expect(JSON.parse(json.body as string)).toEqual({ name: '@rex' });

    const home = join(dir, 'home');
    await mkdir(join(home, 'credentials'), { recursive: true });
    await writeFile(join(home, 'credentials', 'x.json'), '{"secret":1}');
    await expect(
      buildRequest(op(manifest, 'upload-photo'), {
        baseUrl: 'https://api.test',
        args: { petId: 1, file: `@${join(home, 'credentials', 'x.json')}` },
        protectedDirs: [home],
      }),
    ).rejects.toThrow(/Refusing to read/);
    await expect(
      buildRequest(op(manifest, 'upload-photo'), { baseUrl: 'https://api.test', args: { petId: 1, file: `@${dir}` } }),
    ).rejects.toThrow(/not a regular file/);
  });

  it('uploads raw binary bodies and replaces repeated path parameters', async () => {
    const manifest = compileSpec(
      {
        openapi: '3.0.0',
        info: { title: 't', version: '1' },
        paths: {
          '/files/{id}/copy/{id}': {
            put: {
              operationId: 'putFile',
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              requestBody: { content: { 'application/octet-stream': { schema: { type: 'string' } } } },
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      },
      { source: 'inline' },
    );
    const dir = await mkdtemp(join(tmpdir(), 'anycli-raw-'));
    const file = join(dir, 'data.bin');
    await writeFile(file, Buffer.from([7, 8]));
    const put = op(manifest, 'put-file');
    expect(put.inputSchema.properties?.body?.description).toContain('File upload');
    const request = await buildRequest(put, { baseUrl: 'https://api.test', args: { id: 'a', body: `@${file}` } });
    expect(request.url).toBe('https://api.test/files/a/copy/a');
    expect([...(request.body as Uint8Array)]).toEqual([7, 8]);
  });

  it('rejects a missing upload file with a USAGE error', async () => {
    const manifest = await petstore();
    await expect(
      buildRequest(op(manifest, 'upload-photo'), { baseUrl: 'https://api.test', args: { petId: 1, file: '@/nope/missing.png' } }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });
});

describe('OpenAPI adapter', () => {
  let api: MockApi;
  let manifest: OpenApiManifest;
  let target: OpenApiTarget;
  const noAuth = async () => ({ headers: {}, query: {} });
  const OPTS = { raw: false, dryRun: false };

  beforeAll(async () => {
    api = await startMockApi((req) => {
      if (req.path === '/download') return { headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from([1, 2, 3]) };
      if (req.path === '/pets/404') return { status: 404, body: JSON.stringify({ message: 'no such pet' }) };
      if (req.method === 'DELETE') return { status: 204 };
      if (req.path === '/pets' && req.method === 'POST') return { status: 201, body: req.body };
      return undefined;
    });
    manifest = await petstore();
    target = parseTarget({ type: 'openapi', spec: PETSTORE, baseUrl: api.url, headers: { 'X-Static': 's' } }) as OpenApiTarget;
  });
  afterAll(async () => api.close());

  it('lists tools with METHOD path titles', async () => {
    const adapter = openOpenApiAdapter({ name: 'pets', target, manifest, resolveAuth: noAuth });
    const tools = await adapter.listTools();
    expect(tools).toHaveLength(9);
    expect(tools[0]).toMatchObject({ name: 'list-pets', title: 'GET /pets', description: 'List all pets' });
    await expect(adapter.getTool('listPets')).resolves.toMatchObject({ name: 'list-pets' });
    await expect(adapter.getTool('pets')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('calls operations and returns parsed JSON', async () => {
    const adapter = openOpenApiAdapter({ name: 'pets', target, manifest, resolveAuth: noAuth });
    const created = await adapter.callTool(await adapter.getTool('create-pet'), { name: 'Rex' }, OPTS);
    expect(created).toEqual({ ok: true, output: { name: 'Rex' } });
    expect(api.requests.at(-1)?.headers['x-static']).toBe('s');
    const raw = await adapter.callTool(await adapter.getTool('get-pet-by-id'), { petId: 1 }, { ...OPTS, raw: true });
    expect(raw.output).toMatchObject({ status: 200, body: { path: '/pets/1' } });
  });

  it('reports HTTP errors with ok=false and the status', async () => {
    const adapter = openOpenApiAdapter({ name: 'pets', target, manifest, resolveAuth: noAuth });
    const missing = await adapter.callTool(await adapter.getTool('get-pet-by-id'), { petId: 404 }, OPTS);
    expect(missing).toEqual({ ok: false, output: { message: 'no such pet' }, details: { status: 404 } });
  });

  it('handles empty and binary responses', async () => {
    const adapter = openOpenApiAdapter({ name: 'pets', target, manifest, resolveAuth: noAuth });
    const deleted = await adapter.callTool(await adapter.getTool('delete-pets-pet-id'), { petId: 1 }, OPTS);
    expect(deleted).toEqual({ ok: true, output: { status: 204 } });
    const binary = await adapter.callTool(await adapter.getTool('download'), {}, OPTS);
    expect(binary.output).toEqual({
      status: 200,
      contentType: 'application/octet-stream',
      bytes: 3,
      note: 'binary body omitted; use --save <file>',
    });
    const dir = await mkdtemp(join(tmpdir(), 'anycli-dl-'));
    const file = join(dir, 'out.bin');
    const saved = await adapter.callTool(await adapter.getTool('download'), {}, { ...OPTS, save: file });
    expect(saved.output).toMatchObject({ saved: file, bytes: 3 });
    expect([...(await readFile(file))]).toEqual([1, 2, 3]);
  });

  it('renders a dry run with redacted credentials and sends nothing', async () => {
    const before = api.requests.length;
    const adapter = openOpenApiAdapter({
      name: 'pets',
      target,
      manifest,
      resolveAuth: async () => ({ headers: { Authorization: 'Bearer secret-token' }, query: {} }),
    });
    const dry = await adapter.callTool(await adapter.getTool('create-pet'), { name: 'Rex' }, { ...OPTS, dryRun: true });
    expect(dry.output).toMatchObject({ method: 'POST', url: `${api.url}/pets`, body: { name: 'Rex' } });
    expect(JSON.stringify(dry.output)).not.toContain('secret-token');
    expect(api.requests.length).toBe(before);
  });

  it('masks configured headers that come from the environment in dry runs', async () => {
    process.env.ANYCLI_TEST_TENANT = 'tenant-secret';
    try {
      const adapter = openOpenApiAdapter({
        name: 'pets',
        target: { ...target, headers: { 'X-Tenant': '${ANYCLI_TEST_TENANT}', 'X-Static': 's' } },
        manifest,
        resolveAuth: noAuth,
      });
      const dry = await adapter.callTool(await adapter.getTool('list-pets'), {}, { ...OPTS, dryRun: true });
      expect(dry.output).toMatchObject({ headers: { 'X-Tenant': '***', 'X-Static': 's' } });
    } finally {
      delete process.env.ANYCLI_TEST_TENANT;
    }
  });

  it('refuses to --save into protected directories before sending', async () => {
    const home = await mkdtemp(join(tmpdir(), 'anycli-home-'));
    const before = api.requests.length;
    const adapter = openOpenApiAdapter({ name: 'pets', target, manifest, resolveAuth: noAuth, protectedDirs: [home] });
    await expect(
      adapter.callTool(await adapter.getTool('download'), {}, { ...OPTS, save: join(home, 'credentials', 'pets.json') }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(api.requests.length).toBe(before);
  });

  it('refreshes credentials once on 401 and retries', async () => {
    const secured = await startMockApi((req) =>
      req.headers.authorization === 'Bearer fresh' ? undefined : { status: 401, body: '{"error":"expired"}' },
    );
    try {
      const calls: boolean[] = [];
      const adapter = openOpenApiAdapter({
        name: 'pets',
        target: { ...target, baseUrl: secured.url },
        manifest,
        resolveAuth: async (forceRefresh) => {
          calls.push(forceRefresh);
          return { headers: { Authorization: forceRefresh ? 'Bearer fresh' : 'Bearer stale' }, query: {} };
        },
        canRefresh: true,
      });
      const result = await adapter.callTool(await adapter.getTool('list-pets'), {}, OPTS);
      expect(result.ok).toBe(true);
      expect(calls).toEqual([false, true]);
    } finally {
      await secured.close();
    }
  });

  it('maps network failures to CONNECTION errors', async () => {
    const adapter = openOpenApiAdapter({
      name: 'pets',
      target: { ...target, baseUrl: 'http://127.0.0.1:1' },
      manifest,
      resolveAuth: noAuth,
    });
    await expect(adapter.callTool(await adapter.getTool('list-pets'), {}, OPTS)).rejects.toMatchObject({ code: 'CONNECTION' });
  });

  it('requires a base URL', async () => {
    const adapter = openOpenApiAdapter({
      name: 'pets',
      target: { ...target, baseUrl: undefined },
      manifest: { ...manifest, baseUrl: undefined },
      resolveAuth: noAuth,
    });
    await expect(adapter.callTool(await adapter.getTool('list-pets'), {}, OPTS)).rejects.toMatchObject({ code: 'CONFIG' });
  });
});
