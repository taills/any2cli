export const ExitCode = {
  OK: 0,
  GENERAL: 1,
  USAGE: 2,
  AUTH: 3,
  REMOTE: 4,
  CONNECTION: 5,
  CONFIG: 6,
} as const;

export type ErrorCode =
  | 'USAGE'
  | 'CONFIG'
  | 'NOT_FOUND'
  | 'AUTH_REQUIRED'
  | 'AUTH_FAILED'
  | 'REMOTE_ERROR'
  | 'CONNECTION'
  | 'TIMEOUT'
  | 'INTERNAL';

const EXIT_CODES: Record<ErrorCode, number> = {
  USAGE: ExitCode.USAGE,
  NOT_FOUND: ExitCode.USAGE,
  CONFIG: ExitCode.CONFIG,
  AUTH_REQUIRED: ExitCode.AUTH,
  AUTH_FAILED: ExitCode.AUTH,
  REMOTE_ERROR: ExitCode.REMOTE,
  CONNECTION: ExitCode.CONNECTION,
  TIMEOUT: ExitCode.CONNECTION,
  INTERNAL: ExitCode.GENERAL,
};

export interface CliErrorOptions {
  hint?: string;
  details?: unknown;
  cause?: unknown;
}

/** An error meant to be shown to the user (or agent) with a stable code and exit status. */
export class CliError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, options: CliErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CliError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function findCliErrorInChain(error: unknown, depth = 0): CliError | undefined {
  if (error instanceof CliError) return error;
  if (depth > 8 || !(error instanceof Error) || error.cause === undefined) return undefined;
  return findCliErrorInChain(error.cause, depth + 1);
}

export function toCliError(error: unknown): CliError {
  const nested = findCliErrorInChain(error);
  if (nested) return nested;
  if (error instanceof Error) return new CliError('INTERNAL', error.message, { cause: error });
  return new CliError('INTERNAL', String(error));
}
