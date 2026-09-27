import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { CliError } from '../core/errors.js';
import { assertOutsideDirs } from '../core/fs.js';
import type { BodySpec, OperationSpec, ParamSpec } from './compile.js';

export interface AuthMaterial {
  headers: Record<string, string>;
  query: Record<string, string>;
}

export interface BuildRequestInput {
  baseUrl: string;
  args: Record<string, unknown>;
  auth?: AuthMaterial;
  headers?: Record<string, string>;
  /** Directories uploads must never be read from (any2cli's own config and credentials). */
  protectedDirs?: readonly string[];
}

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | FormData | Uint8Array;
  /** A JSON-friendly view of the body, for --dry-run output. */
  bodyPreview?: unknown;
}

function scalar(value: unknown): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

function appendQuery(query: URLSearchParams, param: ParamSpec, value: unknown): void {
  const explode = param.explode ?? (param.style === undefined || param.style === 'form');
  if (Array.isArray(value)) {
    if (explode) value.forEach((item) => query.append(param.name, scalar(item)));
    else query.append(param.name, value.map(scalar).join(param.style === 'pipeDelimited' ? '|' : param.style === 'spaceDelimited' ? ' ' : ','));
    return;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (param.style === 'deepObject') entries.forEach(([key, item]) => query.append(`${param.name}[${key}]`, scalar(item)));
    else if (explode && param.style === 'form') entries.forEach(([key, item]) => query.append(key, scalar(item)));
    else query.append(param.name, JSON.stringify(value));
    return;
  }
  query.append(param.name, scalar(value));
}

function isUploadRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('@') && value.length > 1;
}

async function readUpload(value: string, protectedDirs: readonly string[]): Promise<File> {
  const path = value.slice(1);
  const resolved = await assertOutsideDirs(path, protectedDirs, 'read');
  try {
    const handle = await open(resolved, 'r');
    try {
      if (!(await handle.stat()).isFile()) throw new Error('not a regular file');
      return new File([await handle.readFile()], basename(path));
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new CliError('USAGE', `Cannot read upload file ${path}: ${(error as Error).message}`);
  }
}

function bodyValue(body: BodySpec, args: Record<string, unknown>): unknown {
  if (body.mode === 'raw') return args[body.arg ?? 'body'];
  const picked = Object.fromEntries((body.props ?? []).filter((name) => args[name] !== undefined).map((name) => [name, args[name]]));
  return Object.keys(picked).length > 0 ? picked : undefined;
}

interface EncodeContext {
  body: BodySpec;
  protectedDirs: readonly string[];
}

async function encodeMultipart(value: unknown, context: EncodeContext): Promise<FormData> {
  const form = new FormData();
  const fileArgs = new Set(context.body.fileArgs ?? []);
  for (const [key, item] of Object.entries((value ?? {}) as Record<string, unknown>)) {
    for (const entry of Array.isArray(item) ? item : [item]) {
      if (fileArgs.has(key) && isUploadRef(entry)) form.append(key, await readUpload(entry, context.protectedDirs));
      else form.append(key, scalar(entry));
    }
  }
  return form;
}

async function encodeBody(value: unknown, context: EncodeContext): Promise<{ body: HttpRequest['body']; contentType?: string }> {
  const { contentType } = context.body;
  if (/json/.test(contentType)) return { body: JSON.stringify(value), contentType };
  if (contentType === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams();
    Object.entries((value ?? {}) as Record<string, unknown>).forEach(([key, item]) =>
      (Array.isArray(item) ? item : [item]).forEach((entry) => form.append(key, scalar(entry))),
    );
    return { body: form.toString(), contentType };
  }
  if (contentType === 'multipart/form-data') return { body: await encodeMultipart(value, context) };
  const rawIsFile = context.body.mode === 'raw' && (context.body.fileArgs ?? []).length > 0;
  if (rawIsFile && isUploadRef(value)) {
    return { body: new Uint8Array(await (await readUpload(value, context.protectedDirs)).arrayBuffer()), contentType };
  }
  return { body: scalar(value), contentType };
}

export async function buildRequest(operation: OperationSpec, input: BuildRequestInput): Promise<HttpRequest> {
  const { args } = input;
  const query = new URLSearchParams();
  const cookies: string[] = [];
  const paramHeaders: Record<string, string> = {};
  let path = operation.path;

  for (const param of operation.params) {
    const value = args[param.arg];
    if (value === undefined || value === null) continue;
    if (param.in === 'path') path = path.replaceAll(`{${param.name}}`, encodeURIComponent(scalar(value)));
    else if (param.in === 'query') appendQuery(query, param, value);
    else if (param.in === 'header') paramHeaders[param.name] = scalar(value);
    else cookies.push(`${param.name}=${encodeURIComponent(scalar(value))}`);
  }
  Object.entries(input.auth?.query ?? {}).forEach(([key, value]) => query.set(key, value));

  const { Cookie: authCookie, ...authHeaders } = input.auth?.headers ?? {};
  const allCookies = authCookie ? [...cookies, authCookie] : cookies;

  const value = operation.body ? bodyValue(operation.body, args) : undefined;
  const encoded = operation.body && value !== undefined ? await encodeBody(value, { body: operation.body, protectedDirs: input.protectedDirs ?? [] }) : undefined;
  const search = query.toString();
  const headers: Record<string, string> = {
    Accept: 'application/json, */*;q=0.8',
    ...input.headers,
    ...paramHeaders,
    ...(allCookies.length > 0 ? { Cookie: allCookies.join('; ') } : {}),
    ...authHeaders,
    ...(encoded?.contentType ? { 'Content-Type': encoded.contentType } : {}),
  };
  return {
    method: operation.method,
    url: `${input.baseUrl.replace(/\/+$/, '')}${path}${search ? `?${search}` : ''}`,
    headers,
    ...(encoded ? { body: encoded.body, bodyPreview: value } : {}),
  };
}
