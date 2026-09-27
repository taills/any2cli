import { writeFile } from 'node:fs/promises';
import { DEFAULT_TIMEOUT_MS, type OpenApiTarget } from '../config/schema.js';
import { CliError } from '../core/errors.js';
import { assertOutsideDirs } from '../core/fs.js';
import { interpolate, interpolateDeep } from '../core/interpolate.js';
import { findByName, suggestNames } from '../core/names.js';
import type { CallOptions, CallOutcome, TargetAdapter, ToolDescriptor } from '../core/types.js';
import type { OpenApiManifest, OperationSpec } from './compile.js';
import { buildRequest, type AuthMaterial, type HttpRequest } from './request.js';

export interface OpenApiAdapterOptions {
  name: string;
  target: OpenApiTarget;
  manifest: OpenApiManifest;
  /** Returns auth headers/query; `forceRefresh` is set when retrying after a 401. */
  resolveAuth: (forceRefresh: boolean) => Promise<AuthMaterial>;
  canRefresh?: boolean;
  fetchImpl?: typeof fetch;
  /** Paths uploads and --save must never touch (anycli's own config and credentials). */
  protectedDirs?: readonly string[];
}

const SENSITIVE_HEADER = /authorization|cookie|api[-_]?key|token|secret/i;

function mask(value: string): string {
  const [scheme, rest] = value.split(/\s+/, 2);
  return rest !== undefined && /^(bearer|basic|token|dpop)$/i.test(scheme ?? '') ? `${scheme} ***` : '***';
}

/** Header names whose values are secret: auth material and configured headers that come from the environment. */
function secretHeaderNames(auth: AuthMaterial, configured: Record<string, string> | undefined): Set<string> {
  const fromEnv = Object.entries(configured ?? {})
    .filter(([, value]) => value.includes('${'))
    .map(([key]) => key);
  return new Set([...Object.keys(auth.headers), ...fromEnv].map((key) => key.toLowerCase()));
}

function redactRequest(request: HttpRequest, auth: AuthMaterial, secretHeaders: Set<string>): Record<string, unknown> {
  const url = new URL(request.url);
  Object.keys(auth.query).forEach((key) => url.searchParams.set(key, '***'));
  const headers = Object.fromEntries(
    Object.entries(request.headers).map(([key, value]) => [
      key,
      SENSITIVE_HEADER.test(key) || secretHeaders.has(key.toLowerCase()) ? mask(value) : value,
    ]),
  );
  return {
    dryRun: true,
    method: request.method,
    url: Object.keys(auth.query).length > 0 ? url.toString() : request.url,
    headers,
    ...(request.bodyPreview !== undefined ? { body: request.bodyPreview } : {}),
  };
}

function isTextual(contentType: string): boolean {
  return contentType === '' || /^text\/|xml|javascript|html|x-www-form-urlencoded|csv|yaml/.test(contentType);
}

/** `writePath` is the validated, symlink-resolved form of `options.save`. */
async function readResponse(response: Response, options: CallOptions, writePath: string | undefined): Promise<unknown> {
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const bytes = Buffer.from(await response.arrayBuffer());
  if (options.save !== undefined && writePath !== undefined) {
    await writeFile(writePath, bytes);
    return { saved: options.save, status: response.status, contentType, bytes: bytes.length };
  }
  if (bytes.length === 0) return { status: response.status };
  if (contentType.includes('json')) {
    const text = bytes.toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (isTextual(contentType)) return bytes.toString('utf8');
  return { status: response.status, contentType, bytes: bytes.length, note: 'binary body omitted; use --save <file>' };
}

function toDescriptor(operation: OperationSpec): ToolDescriptor {
  const text = [operation.summary, operation.description].filter(Boolean).join('\n\n');
  return {
    name: operation.name,
    title: `${operation.method} ${operation.path}`,
    description: operation.deprecated ? `[deprecated] ${text}` : text || undefined,
    inputSchema: operation.inputSchema,
  };
}

class OpenApiAdapter implements TargetAdapter {
  private readonly tools: ToolDescriptor[];
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenApiAdapterOptions) {
    this.tools = options.manifest.operations.map(toDescriptor);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    return this.tools;
  }

  async getTool(name: string): Promise<ToolDescriptor> {
    const byName = findByName(this.tools, name);
    const byOperationId = this.options.manifest.operations.find((op) => op.operationId === name);
    const tool = byName ?? (byOperationId ? this.tools.find((item) => item.name === byOperationId.name) : undefined);
    if (tool) return tool;
    const similar = suggestNames(this.tools, name);
    throw new CliError('NOT_FOUND', `Operation "${name}" not found on target "${this.options.name}"`, {
      hint: similar.length > 0 ? `Did you mean: ${similar.join(', ')}?` : `Run \`anycli tools ${this.options.name}\` to list operations`,
    });
  }

  private baseUrl(): string {
    const configured = this.options.target.baseUrl;
    const baseUrl = configured ? interpolate(configured) : this.options.manifest.baseUrl;
    if (!baseUrl) {
      throw new CliError('CONFIG', `Target "${this.options.name}" has no base URL`, {
        hint: 'The spec declares no absolute server URL; set one with `anycli add openapi <name> <spec> --base-url <url>`',
      });
    }
    return baseUrl;
  }

  private async send(request: HttpRequest, timeoutMs: number): Promise<Response> {
    try {
      return await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body as RequestInit['body'],
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = (error as Error).name === 'TimeoutError';
      const cause = (error as { cause?: { message?: string } }).cause?.message;
      throw new CliError(
        timedOut ? 'TIMEOUT' : 'CONNECTION',
        timedOut ? `Request timed out after ${timeoutMs}ms` : `Request to ${new URL(request.url).origin} failed: ${cause ?? (error as Error).message}`,
        { cause: error },
      );
    }
  }

  async callTool(tool: ToolDescriptor, args: Record<string, unknown>, options: CallOptions): Promise<CallOutcome> {
    const operation = this.options.manifest.operations.find((op) => op.name === tool.name);
    if (!operation) throw new CliError('NOT_FOUND', `Operation "${tool.name}" not found`);
    const timeoutMs = options.timeoutMs ?? this.options.target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const protectedDirs = this.options.protectedDirs ?? [];
    const input = { baseUrl: this.baseUrl(), args, headers: interpolateDeep(this.options.target.headers), protectedDirs };

    let auth = await this.options.resolveAuth(false);
    let request = await buildRequest(operation, { ...input, auth });
    if (options.dryRun) {
      return { ok: true, output: redactRequest(request, auth, secretHeaderNames(auth, this.options.target.headers)) };
    }
    const save = options.save === undefined ? undefined : await assertOutsideDirs(options.save, protectedDirs, 'write');

    let response = await this.send(request, timeoutMs);
    if (response.status === 401 && this.options.canRefresh) {
      await response.body?.cancel();
      auth = await this.options.resolveAuth(true);
      request = await buildRequest(operation, { ...input, auth });
      response = await this.send(request, timeoutMs);
    }
    const body = await readResponse(response, options, save);
    const output = options.raw ? { status: response.status, headers: Object.fromEntries(response.headers), body } : body;
    if (response.ok) return { ok: true, output };
    const hint =
      response.status === 401 || response.status === 403
        ? `Check credentials; for OAuth2 targets run \`anycli auth login ${this.options.name}\``
        : undefined;
    return { ok: false, output, details: { status: response.status, ...(hint ? { hint } : {}) } };
  }

  async close(): Promise<void> {}
}

export function openOpenApiAdapter(options: OpenApiAdapterOptions): TargetAdapter {
  return new OpenApiAdapter(options);
}
