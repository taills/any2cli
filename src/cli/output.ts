import type { Writable } from 'node:stream';
import { CliError } from '../core/errors.js';

export interface Io {
  stdout: Writable;
  stderr: Writable;
  stdoutIsTTY: boolean;
}

export interface PrinterOptions {
  json: boolean;
  pretty: boolean;
}

/**
 * All user-visible output goes through here. Results go to stdout (plain text as-is, anything
 * else as JSON — compact when piped, indented on a terminal); progress and errors go to stderr.
 */
export class Printer {
  constructor(
    private readonly io: Io,
    readonly options: PrinterOptions,
  ) {}

  get json(): boolean {
    return this.options.json;
  }

  private stringify(value: unknown): string {
    return JSON.stringify(value, null, this.options.pretty || this.io.stdoutIsTTY ? 2 : undefined) ?? 'null';
  }

  /** Prints a tool/command result. */
  data(value: unknown): void {
    if (value === undefined) return;
    const text = typeof value === 'string' ? value : this.stringify(value);
    this.io.stdout.write(text.endsWith('\n') || text === '' ? text : `${text}\n`);
  }

  /** Prints `json` in --json mode, otherwise the human-readable `text`. */
  result(json: unknown, text: string): void {
    this.data(this.options.json ? (json ?? null) : text);
  }

  info(line: string): void {
    this.io.stderr.write(`${line}\n`);
  }

  error(error: CliError): void {
    if (this.options.json) {
      this.io.stderr.write(`${JSON.stringify({ error: error.toJSON() })}\n`);
      return;
    }
    const lines = [`error: ${error.message}`];
    if (error.hint) lines.push(`hint: ${error.hint}`);
    const stderrTail = (error.details as { stderr?: string } | undefined)?.stderr;
    if (stderrTail) lines.push('server stderr:', ...stderrTail.split('\n').map((line) => `  ${line}`));
    this.io.stderr.write(`${lines.join('\n')}\n`);
  }
}

export function table(rows: string[][]): string {
  if (rows.length === 0) return '';
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length))) ?? [];
  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0))).join('  ').trimEnd()).join('\n');
}

export function assertNever(message: string): never {
  throw new CliError('INTERNAL', message);
}
