import { resolve } from 'node:path';
import $RefParser, { type ParserOptions } from '@apidevtools/json-schema-ref-parser';
import converter from 'swagger2openapi';
import { CliError } from '../core/errors.js';

/** A parsed OpenAPI 3.x document. Kept loose on purpose: real-world specs vary a lot. */
export type OpenApiDocument = Record<string, unknown>;

export function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

export function normalizeSource(source: string, cwd = process.cwd()): string {
  return isUrl(source) ? source : resolve(cwd, source);
}

/**
 * The spec URL is chosen explicitly by the user, so the library's server-side SSRF guard is
 * turned off: it rejects localhost dev servers and hosts behind fake-IP proxies (198.18.0.0/15).
 */
const PARSER_OPTIONS: ParserOptions = {
  resolve: { http: { safeUrlResolver: false, timeout: 30_000 } },
  dereference: { circular: 'ignore', preservedProperties: ['summary', 'description'] },
};

async function dereference(input: string | OpenApiDocument): Promise<OpenApiDocument> {
  return (await $RefParser.dereference(input as never, PARSER_OPTIONS)) as unknown as OpenApiDocument;
}

/**
 * Loads an OpenAPI 3.x or Swagger 2.0 document from a URL or file (JSON or YAML), resolving
 * external references. Circular references are left in place and handled by the compiler.
 */
export async function loadSpec(source: string): Promise<OpenApiDocument> {
  const location = normalizeSource(source);
  try {
    const document = await dereference(location);
    if (typeof document.swagger === 'string' && document.swagger.startsWith('2')) {
      const { openapi } = await converter.convertObj(document as never, { patch: true, warnOnly: true });
      return await dereference(openapi as unknown as OpenApiDocument);
    }
    if (typeof document.openapi !== 'string') {
      throw new Error('document has neither an "openapi" nor a "swagger" version field');
    }
    return document;
  } catch (error) {
    throw new CliError('CONFIG', `Cannot load OpenAPI spec from ${location}: ${(error as Error).message}`, { cause: error });
  }
}
