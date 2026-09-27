import { chmod, mkdir, open, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CliError } from './errors.js';

/** Writes a file atomically (temp file + rename) with restrictive permissions for secrets. */
export async function writeFileAtomic(path: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, content, { mode, flag: 'wx' });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** Creates a directory readable only by the current user, tightening it if it already exists. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_HEARTBEAT_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` while holding an exclusive lock file, so parallel any2cli processes (e.g. an agent
 * running several calls at once) don't lose updates. The holder refreshes the lock's mtime while
 * it works, so only locks left behind by crashed runs ever look stale and get broken.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age = await stat(lockPath).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new CliError('TIMEOUT', `Timed out waiting for lock ${lockPath}`, {
          hint: `If no other any2cli process is running, delete ${lockPath}`,
        });
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(lockPath, now, now).catch(() => undefined);
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await rm(lockPath, { force: true });
  }
}

/** Resolves symlinks for the longest existing prefix of `path`. */
async function realPathLenient(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(await realPathLenient(parent), basename(path));
  }
}

/**
 * Refuses file access inside protected directories (any2cli's own config and credentials).
 * Returns the symlink-resolved path; callers do their I/O on it, not on the original path.
 */
export async function assertOutsideDirs(path: string, protectedDirs: readonly string[], action: 'read' | 'write'): Promise<string> {
  const target = await realPathLenient(path);
  for (const dir of protectedDirs) {
    const rel = relative(await realPathLenient(dir), target);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      throw new CliError('USAGE', `Refusing to ${action} ${path}: it is inside any2cli's private directory ${dir}`);
    }
  }
  return target;
}
