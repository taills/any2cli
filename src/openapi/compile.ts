import { toKebabCase } from '../core/names.js';
import type { JsonSchema } from '../core/types.js';
import { isUrl, type OpenApiDocument } from './load.js';
import { derefLocal, sanitizeSchema } from './schema.js';

export type ParamLocation = 'path' | 'query' | 'header' | 'cookie';

export interface ParamSpec {
  arg: string;
  name: string;
  in: ParamLocation;
  required: boolean;
  style?: string;
  explode?: boolean;
}

export interface BodySpec {
  contentType: string;
  required: boolean;
  /** `flat`: object properties become top-level parameters; `raw`: one parameter holds the body. */
  mode: 'flat' | 'raw';
  arg?: string;
  props?: string[];
  /** Parameters whose values may be `@/path/to/file` uploads (binary schema fields). */
  fileArgs?: string[];
}

export interface OperationSpec {
  name: string;
  operationId?: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  deprecated?: boolean;
  params: ParamSpec[];
  body?: BodySpec;
  inputSchema: JsonSchema;
}

export interface SecuritySummary {
  name: string;
  type: string;
  flow?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  deviceAuthorizationUrl?: string;
  discoveryUrl?: string;
  scopes?: string[];
  in?: string;
  paramName?: string;
  scheme?: string;
}

export interface OpenApiManifest {
  version: number;
  title: string;
  specVersion: string;
  source: string;
  baseUrl?: string;
  compiledAt: string;
  security: SecuritySummary[];
  operations: OperationSpec[];
}

export interface CompileOptions {
  source: string;
  include?: string[];
  exclude?: string[];
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
const LOCATIONS = new Set<string>(['path', 'query', 'header', 'cookie']);

type Obj = Record<string, unknown>;

function asObj(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolveBaseUrl(doc: OpenApiDocument, source: string): string | undefined {
  const server = asObj((doc.servers as unknown[] | undefined)?.[0]);
  const template = str(server.url);
  if (!template) return isUrl(source) ? new URL(source).origin : undefined;
  const variables = asObj(server.variables);
  const expanded = template.replace(/\{([^}]+)\}/g, (match, name: string) => str(asObj(variables[name]).default) ?? match);
  if (/^https?:\/\//i.test(expanded)) return expanded.replace(/\/+$/, '');
  return isUrl(source) ? new URL(expanded, source).href.replace(/\/+$/, '') : undefined;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function matches(op: OperationSpec, pattern: string): boolean {
  if (pattern.startsWith('tag:')) {
    const tag = globToRegExp(pattern.slice(4));
    return op.tags.some((candidate) => tag.test(candidate));
  }
  const regex = globToRegExp(pattern);
  return regex.test(op.name) || (op.operationId !== undefined && regex.test(op.operationId));
}

function collectParams(doc: OpenApiDocument, pathItem: Obj, operation: Obj): Obj[] {
  const all = [...((pathItem.parameters as unknown[]) ?? []), ...((operation.parameters as unknown[]) ?? [])].map((param) =>
    asObj(derefLocal(doc, param)),
  );
  const byKey = new Map<string, Obj>();
  all.filter((param) => str(param.name) && LOCATIONS.has(String(param.in))).forEach((param) => byKey.set(`${param.in}:${param.name}`, param));
  return [...byKey.values()];
}

function paramSchema(doc: OpenApiDocument, param: Obj): JsonSchema {
  const content = asObj(param.content);
  const fromContent = Object.values(content).map((media) => asObj(media).schema)[0];
  const schema = sanitizeSchema(doc, param.schema ?? fromContent ?? { type: 'string' });
  const description = str(param.description);
  return description ? { ...schema, description } : schema;
}

const CONTENT_PREFERENCE = [
  (type: string) => type === 'application/json',
  (type: string) => /[/+]json\b/.test(type),
  (type: string) => type === 'application/x-www-form-urlencoded',
  (type: string) => type === 'multipart/form-data',
];

function pickContentType(content: Obj): string | undefined {
  const types = Object.keys(content);
  for (const prefer of CONTENT_PREFERENCE) {
    const found = types.find(prefer);
    if (found) return found;
  }
  return types[0];
}

interface BodyResult {
  body: BodySpec;
  properties: Record<string, JsonSchema>;
  required: string[];
}

export const MANIFEST_VERSION = 2;

function isBinarySchema(schema: JsonSchema | undefined): boolean {
  if (!schema) return false;
  return schema.format === 'binary' || schema.contentMediaType !== undefined || isBinarySchema(schema.items);
}

function annotateUpload(schema: JsonSchema): JsonSchema {
  if (!isBinarySchema(schema)) return schema;
  const note = 'File upload: pass @/path/to/file';
  return { ...schema, description: schema.description ? `${schema.description} (${note})` : note };
}

function compileBody(doc: OpenApiDocument, operation: Obj, taken: Set<string>): BodyResult | undefined {
  const requestBody = asObj(derefLocal(doc, operation.requestBody));
  const content = asObj(requestBody.content);
  const contentType = pickContentType(content);
  if (!contentType) return undefined;
  const required = requestBody.required === true;
  const schema = sanitizeSchema(doc, asObj(content[contentType]).schema ?? {});
  const props = Object.entries(schema.properties ?? {}).filter(([, prop]) => prop.readOnly !== true);
  const isObject = schema.type === 'object' || (schema.type === undefined && schema.properties !== undefined);
  const flat = isObject && props.length > 0 && props.every(([name]) => !taken.has(name));

  if (flat) {
    return {
      body: {
        contentType,
        required,
        mode: 'flat',
        props: props.map(([name]) => name),
        fileArgs: props.filter(([, prop]) => isBinarySchema(prop)).map(([name]) => name),
      },
      properties: Object.fromEntries(props.map(([name, prop]) => [name, annotateUpload(prop)])),
      required: required ? (schema.required ?? []).filter((name) => props.some(([prop]) => prop === name)) : [],
    };
  }
  const arg = taken.has('body') ? '_body' : 'body';
  const description = str(requestBody.description) ?? `Request body (${contentType})`;
  const binary = isBinarySchema(schema) || /octet-stream|^image\/|^audio\/|^video\/|^application\/(pdf|zip)/.test(contentType);
  return {
    body: { contentType, required, mode: 'raw', arg, fileArgs: binary ? [arg] : [] },
    properties: { [arg]: annotateUpload({ ...schema, ...(binary ? { format: 'binary' } : {}), description: schema.description ?? description }) },
    required: required ? [arg] : [],
  };
}

function compileOperation(doc: OpenApiDocument, path: string, method: string, pathItem: Obj, operation: Obj): OperationSpec {
  const operationId = str(operation.operationId);
  const taken = new Set<string>();
  const params: ParamSpec[] = [];
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const param of collectParams(doc, pathItem, operation)) {
    const name = String(param.name);
    const location = param.in as ParamLocation;
    const arg = taken.has(name) ? `${location}-${name}` : name;
    const isRequired = location === 'path' || param.required === true;
    taken.add(arg);
    params.push({
      arg,
      name,
      in: location,
      required: isRequired,
      ...(str(param.style) ? { style: String(param.style) } : {}),
      ...(typeof param.explode === 'boolean' ? { explode: param.explode } : {}),
    });
    properties[arg] = paramSchema(doc, param);
    if (isRequired) required.push(arg);
  }

  const body = compileBody(doc, operation, taken);
  return {
    name: toKebabCase(operationId ?? `${method} ${path}`),
    ...(operationId ? { operationId } : {}),
    method: method.toUpperCase(),
    path,
    ...(str(operation.summary) ? { summary: String(operation.summary) } : {}),
    ...(str(operation.description) ? { description: String(operation.description) } : {}),
    tags: Array.isArray(operation.tags) ? operation.tags.map(String) : [],
    ...(operation.deprecated === true ? { deprecated: true } : {}),
    params,
    ...(body ? { body: body.body } : {}),
    inputSchema: {
      type: 'object',
      properties: { ...properties, ...body?.properties },
      required: [...required, ...(body?.required ?? [])],
    },
  };
}

function dedupeNames(operations: OperationSpec[]): OperationSpec[] {
  const seen = new Map<string, number>();
  return operations.map((operation) => {
    const count = (seen.get(operation.name) ?? 0) + 1;
    seen.set(operation.name, count);
    return count === 1 ? operation : { ...operation, name: `${operation.name}-${count}` };
  });
}

const OAUTH_FLOWS: Array<[string, string]> = [
  ['authorizationCode', 'authorization_code'],
  ['clientCredentials', 'client_credentials'],
];

function summarizeSecurity(doc: OpenApiDocument): SecuritySummary[] {
  const schemes = asObj(asObj(doc.components).securitySchemes);
  return Object.entries(schemes).map(([name, raw]) => {
    const scheme = asObj(derefLocal(doc, raw));
    const type = String(scheme.type);
    if (type === 'oauth2') {
      const flows = asObj(scheme.flows);
      const [key, flow] = OAUTH_FLOWS.find(([candidate]) => flows[candidate] !== undefined) ?? [];
      const details = asObj(key ? flows[key] : undefined);
      return {
        name,
        type,
        ...(flow ? { flow } : {}),
        ...(str(details.authorizationUrl) ? { authorizationUrl: String(details.authorizationUrl) } : {}),
        ...(str(details.tokenUrl) ? { tokenUrl: String(details.tokenUrl) } : {}),
        scopes: Object.keys(asObj(details.scopes)),
      };
    }
    if (type === 'openIdConnect') return { name, type, ...(str(scheme.openIdConnectUrl) ? { discoveryUrl: String(scheme.openIdConnectUrl) } : {}) };
    if (type === 'apiKey') return { name, type, in: String(scheme.in), paramName: String(scheme.name) };
    return { name, type, ...(str(scheme.scheme) ? { scheme: String(scheme.scheme).toLowerCase() } : {}) };
  });
}

export function compileSpec(doc: OpenApiDocument, options: CompileOptions): OpenApiManifest {
  const paths = asObj(doc.paths);
  const compiled = Object.entries(paths).flatMap(([path, rawItem]) => {
    const pathItem = asObj(derefLocal(doc, rawItem));
    return METHODS.filter((method) => pathItem[method] !== undefined).map((method) =>
      compileOperation(doc, path, method, pathItem, asObj(pathItem[method])),
    );
  });
  const included = options.include?.length ? compiled.filter((op) => options.include?.some((p) => matches(op, p))) : compiled;
  const operations = dedupeNames(included.filter((op) => !options.exclude?.some((p) => matches(op, p))));
  const info = asObj(doc.info);
  const baseUrl = resolveBaseUrl(doc, options.source);
  return {
    version: MANIFEST_VERSION,
    title: str(info.title) ?? 'Untitled API',
    specVersion: String(doc.openapi ?? doc.swagger ?? 'unknown'),
    source: options.source,
    ...(baseUrl ? { baseUrl } : {}),
    compiledAt: new Date().toISOString(),
    security: summarizeSecurity(doc),
    operations,
  };
}
