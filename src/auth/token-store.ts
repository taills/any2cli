import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from '../core/errors.js';
import { ensurePrivateDir, isNotFound, withFileLock, writeFileAtomic } from '../core/fs.js';

export interface TokenSet {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  scope?: string;
  idToken?: string;
  obtainedAt: number;
}

export interface McpCredentials {
  tokens?: Record<string, unknown>;
  obtainedAt?: number;
  clientInformation?: Record<string, unknown>;
  redirectUri?: string;
  discoveryState?: unknown;
}

export interface CredentialRecord {
  version: 1;
  oauth2?: TokenSet;
  mcp?: McpCredentials;
  [key: string]: unknown;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Stores OAuth tokens per target as owner-only (0600) JSON files in an owner-only (0700)
 * directory. Updates take a lock file so parallel agent invocations don't race on refresh-token
 * rotation.
 */
export class CredentialStore {
  constructor(readonly dir: string) {}

  private file(name: string): string {
    if (!SAFE_NAME.test(name) || name.includes('..')) throw new CliError('USAGE', `Invalid target name "${name}"`);
    return join(this.dir, `${name}.json`);
  }

  async read(name: string): Promise<CredentialRecord> {
    const path = this.file(name);
    try {
      return JSON.parse(await readFile(path, 'utf8')) as CredentialRecord;
    } catch (error) {
      if (isNotFound(error)) return { version: 1 };
      throw new CliError('CONFIG', `Credential file for "${name}" is unreadable: ${(error as Error).message}`, {
        hint: `Run \`anycli auth logout ${name}\` and log in again`,
      });
    }
  }

  private async write(name: string, record: CredentialRecord): Promise<void> {
    await ensurePrivateDir(this.dir);
    await writeFileAtomic(this.file(name), `${JSON.stringify(record, null, 2)}\n`);
  }

  async remove(name: string): Promise<void> {
    await rm(this.file(name), { force: true });
  }

  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.file(name)}.lock`;
    await ensurePrivateDir(this.dir);
    return withFileLock(lockPath, fn);
  }

  /** Read-modify-write under the lock. */
  async update(name: string, fn: (record: CredentialRecord) => CredentialRecord | Promise<CredentialRecord>): Promise<CredentialRecord> {
    return this.withLock(name, async () => {
      const next = await fn(await this.read(name));
      await this.write(name, next);
      return next;
    });
  }

  /** Write while the caller already holds the lock. */
  async writeLocked(name: string, record: CredentialRecord): Promise<void> {
    await this.write(name, record);
  }
}
