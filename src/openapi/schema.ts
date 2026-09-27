import type { JsonSchema } from '../core/types.js';

const MAX_DEPTH = 8;
const DROPPED_KEYS = new Set(['xml', 'externalDocs', 'discriminator']);

function resolvePointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .map((segment) => decodeURIComponent(segment.replace(/~1/g, '/').replace(/~0/g, '~')))
    .reduce<unknown>((node, key) => (node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined), root);
}

/** Follows a local `$ref` (if any) and returns the referenced object. */
export function derefLocal<T>(root: unknown, value: T): T {
  let current: unknown = value;
  for (let hops = 0; hops < 10; hops += 1) {
    const ref = (current as { $ref?: unknown } | null)?.$ref;
    if (typeof ref !== 'string') break;
    const next = resolvePointer(root, ref);
    if (next === undefined) break;
    current = next;
  }
  return current as T;
}

function refName(ref: string): string {
  return ref.split('/').pop() ?? ref;
}

/**
 * Produces a self-contained, bounded copy of a schema for use as a tool input schema:
 * local `$ref`s are inlined, recursion is cut with a descriptive placeholder, nesting is
 * limited, and noise such as `xml` metadata is dropped. The input is never mutated.
 */
export function sanitizeSchema(root: unknown, schema: unknown, stack: readonly string[] = [], depth = 0): JsonSchema {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return {};
  const ref = (schema as { $ref?: unknown }).$ref;
  if (typeof ref === 'string') {
    const target = resolvePointer(root, ref);
    if (target === undefined || stack.includes(ref)) {
      return { type: 'object', description: `Recursive reference to ${refName(ref)}` };
    }
    return sanitizeSchema(root, target, [...stack, ref], depth);
  }
  const source = schema as Record<string, unknown>;
  if (depth >= MAX_DEPTH) {
    return { ...(source.type ? { type: source.type as string } : {}), description: 'Deeply nested structure (truncated)' };
  }
  const next = (value: unknown): JsonSchema => sanitizeSchema(root, value, stack, depth + 1);
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => !DROPPED_KEYS.has(key))
      .map(([key, value]) => {
        if (key === 'properties' && value && typeof value === 'object') {
          return [key, Object.fromEntries(Object.entries(value).map(([name, prop]) => [name, next(prop)]))];
        }
        if ((key === 'items' || key === 'not' || key === 'additionalProperties') && value && typeof value === 'object') {
          return [key, next(value)];
        }
        if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
          return [key, value.map(next)];
        }
        return [key, value];
      }),
  ) as JsonSchema;
}
