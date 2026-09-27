import { writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { assertOutsideDirs } from '../core/fs.js';
import type { CallOptions, CallOutcome } from '../core/types.js';

interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
}

export interface McpCallResult {
  content?: ContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

function savePath(base: string, index: number): string {
  if (index === 0) return base;
  const ext = extname(base);
  return `${base.slice(0, base.length - ext.length)}-${index + 1}${ext}`;
}

interface BinaryBlock {
  kind: string;
  data: string;
  mimeType: string;
}

async function renderBinary(block: BinaryBlock, index: number, options: CallOptions, protectedDirs: readonly string[]): Promise<string> {
  const { kind, mimeType } = block;
  const bytes = Buffer.from(block.data, 'base64');
  if (options.save === undefined) return `[${kind} ${mimeType}, ${bytes.length} bytes omitted; use --save <file> or --raw]`;
  const path = savePath(options.save, index);
  await writeFile(await assertOutsideDirs(path, protectedDirs, 'write'), bytes);
  return `[${kind} ${mimeType} saved to ${path}]`;
}

/** True when structured content merely wraps the text output, e.g. `{ "content": "<same text>" }`. */
function isTextWrapper(structured: unknown, blocks: ContentBlock[]): boolean {
  if (structured === null || typeof structured !== 'object' || Array.isArray(structured)) return false;
  const values = Object.values(structured);
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n\n');
  return values.length === 1 && typeof values[0] === 'string' && values[0] === text && blocks.every((block) => block.type === 'text');
}

/**
 * Turns an MCP CallToolResult into something compact for an agent to read: structured content
 * as JSON, text blocks as plain text, and binary blocks summarized (or saved with --save).
 */
export async function formatMcpResult(
  result: McpCallResult,
  options: CallOptions,
  protectedDirs: readonly string[] = [],
): Promise<CallOutcome> {
  const ok = result.isError !== true;
  if (options.raw) return { ok, output: result };
  const blocks = result.content ?? [];
  if (result.structuredContent !== undefined && ok && !isTextWrapper(result.structuredContent, blocks)) {
    return { ok, output: result.structuredContent };
  }

  let binaryIndex = 0;
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push(block.text ?? '');
    } else if ((block.type === 'image' || block.type === 'audio') && block.data !== undefined) {
      const binary = { kind: block.type, data: block.data, mimeType: block.mimeType ?? 'application/octet-stream' };
      parts.push(await renderBinary(binary, binaryIndex, options, protectedDirs));
      binaryIndex += 1;
    } else if (block.type === 'resource' && block.resource) {
      const { resource } = block;
      if (resource.text !== undefined) {
        parts.push(resource.text);
      } else if (resource.blob !== undefined) {
        const binary = { kind: 'resource', data: resource.blob, mimeType: resource.mimeType ?? 'application/octet-stream' };
        parts.push(await renderBinary(binary, binaryIndex, options, protectedDirs));
        binaryIndex += 1;
      }
    } else if (block.type === 'resource_link') {
      parts.push(`[resource link: ${block.uri}]`);
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  return { ok, output: parts.join('\n\n') };
}
