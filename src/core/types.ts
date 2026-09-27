/** A (loosely typed) JSON Schema object as found in MCP tool definitions and OpenAPI specs. */
export type JsonSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  format?: string;
  [key: string]: unknown;
};

/** The unified shape every backend (MCP server or OpenAPI operation) exposes to the CLI. */
export interface ToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
}

export interface CallOptions {
  raw: boolean;
  dryRun: boolean;
  timeoutMs?: number;
  save?: string;
}

/** Result of calling a tool: printable payload plus whether the backend reported failure. */
export interface CallOutcome {
  ok: boolean;
  output: unknown;
  /** Extra detail for error reporting (e.g. HTTP status). */
  details?: Record<string, unknown>;
}

export interface TargetAdapter {
  listTools(): Promise<ToolDescriptor[]>;
  getTool(name: string): Promise<ToolDescriptor>;
  callTool(tool: ToolDescriptor, args: Record<string, unknown>, options: CallOptions): Promise<CallOutcome>;
  close(): Promise<void>;
}
