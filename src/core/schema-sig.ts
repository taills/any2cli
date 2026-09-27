import type { JsonSchema, ToolDescriptor } from './types.js';

function nonNullVariants(schema: JsonSchema): JsonSchema[] {
  return (schema.anyOf ?? schema.oneOf ?? []).filter((variant) => variant.type !== 'null');
}

export function typeLabel(schema: JsonSchema): string {
  if (schema.enum && schema.enum.length > 0 && schema.enum.length <= 8) return schema.enum.map(String).join('|');
  const types = Array.isArray(schema.type) ? schema.type.filter((type) => type !== 'null') : schema.type ? [schema.type] : [];
  const type = types[0];
  if (type === 'array') return `${schema.items ? typeLabel(schema.items) : 'value'}[]`;
  if (type === 'object') return 'json';
  if (type) return type;
  const variants = nonNullVariants(schema);
  if (variants.length === 1) return typeLabel(variants[0] as JsonSchema);
  if (variants.length > 1) return 'json';
  if (schema.properties) return 'json';
  return 'value';
}

interface ParamLine {
  name: string;
  schema: JsonSchema;
  required: boolean;
}

function params(tool: ToolDescriptor): ParamLine[] {
  const properties = tool.inputSchema.properties ?? {};
  const required = new Set(tool.inputSchema.required ?? []);
  const lines = Object.entries(properties).map(([name, schema]) => ({ name, schema, required: required.has(name) }));
  return [...lines.filter((line) => line.required), ...lines.filter((line) => !line.required)];
}

function flag(line: ParamLine): string {
  const label = typeLabel(line.schema);
  return label === 'boolean' ? `--${line.name}` : `--${line.name} <${label}>`;
}

export function renderSignature(tool: ToolDescriptor): string {
  const parts = params(tool).map((line) => (line.required ? flag(line) : `[${flag(line)}]`));
  return [tool.name, ...parts].join(' ');
}

export function firstLine(text: string | undefined, max = 120): string {
  const line = (text ?? '').trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function describeParam(line: ParamLine): string {
  const notes = [
    line.required ? '(required)' : '',
    (line.schema.description ?? '').replace(/\s+/g, ' ').trim(),
    line.schema.default !== undefined ? `[default: ${JSON.stringify(line.schema.default)}]` : '',
  ].filter(Boolean);
  return notes.join(' ');
}

export function renderToolHelp(tool: ToolDescriptor, commandPrefix: string): string {
  const lines = params(tool);
  const width = Math.min(40, Math.max(0, ...lines.map((line) => flag(line).length)));
  const body = lines.map((line) => `  ${flag(line).padEnd(width)}  ${describeParam(line)}`.trimEnd());
  return [
    tool.title && tool.title !== tool.name ? `${tool.title}\n` : '',
    tool.description ? `${tool.description.trim()}\n` : '',
    `Usage:\n  ${commandPrefix} ${renderSignature(tool)}\n`,
    lines.length > 0 ? `Parameters:\n${body.join('\n')}\n` : 'Parameters: none\n',
    "Also accepts: --args '<json>'  --args-file <path|->  --raw  --dry-run  --call-timeout <ms>  --save <file>",
  ]
    .filter(Boolean)
    .join('\n');
}
