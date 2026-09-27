import { mkdir, mkdtemp, realpath, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { assertOutsideDirs, withFileLock } from '../../src/core/fs.js';
import { CliError, ExitCode, toCliError } from '../../src/core/errors.js';
import { interpolate, interpolateDeep } from '../../src/core/interpolate.js';
import { assertTargetName, findByName, normalizeKey, toKebabCase } from '../../src/core/names.js';

describe('CliError', () => {
  it('maps error codes to exit codes', () => {
    expect(new CliError('USAGE', 'x').exitCode).toBe(ExitCode.USAGE);
    expect(new CliError('AUTH_REQUIRED', 'x').exitCode).toBe(ExitCode.AUTH);
    expect(new CliError('REMOTE_ERROR', 'x').exitCode).toBe(ExitCode.REMOTE);
    expect(new CliError('CONNECTION', 'x').exitCode).toBe(ExitCode.CONNECTION);
    expect(new CliError('CONFIG', 'x').exitCode).toBe(ExitCode.CONFIG);
    expect(new CliError('INTERNAL', 'x').exitCode).toBe(ExitCode.GENERAL);
  });

  it('serializes to a JSON-friendly shape', () => {
    const err = new CliError('NOT_FOUND', 'missing', { hint: 'try list', details: { a: 1 } });
    expect(err.toJSON()).toEqual({ code: 'NOT_FOUND', message: 'missing', hint: 'try list', details: { a: 1 } });
  });

  it('wraps unknown errors', () => {
    expect(toCliError(new Error('boom'))).toMatchObject({ code: 'INTERNAL', message: 'boom' });
    expect(toCliError('text')).toMatchObject({ code: 'INTERNAL', message: 'text' });
    const original = new CliError('USAGE', 'u');
    expect(toCliError(original)).toBe(original);
  });

  it('finds a CliError nested in the cause chain', () => {
    const inner = new CliError('AUTH_REQUIRED', 'login');
    const outer = new Error('wrapped', { cause: inner });
    expect(toCliError(outer)).toBe(inner);
  });
});

describe('interpolate', () => {
  const env = { TOKEN: 'abc', EMPTY: '' };

  it('replaces ${VAR} and ${env:VAR}', () => {
    expect(interpolate('Bearer ${TOKEN}', env)).toBe('Bearer abc');
    expect(interpolate('${env:TOKEN}-x', env)).toBe('abc-x');
  });

  it('supports default values', () => {
    expect(interpolate('${MISSING:-fallback}', env)).toBe('fallback');
  });

  it('keeps escaped $${VAR} literally', () => {
    expect(interpolate('$${TOKEN}', env)).toBe('${TOKEN}');
  });

  it('throws a CONFIG error when a variable is missing', () => {
    expect(() => interpolate('${NOPE}', env)).toThrow(CliError);
    expect(() => interpolate('${NOPE}', env)).toThrow(/NOPE/);
  });

  it('interpolates nested structures without mutating the input', () => {
    const input = { a: '${TOKEN}', b: ['${TOKEN}', 1], c: { d: '${EMPTY}' } };
    const output = interpolateDeep(input, env);
    expect(output).toEqual({ a: 'abc', b: ['abc', 1], c: { d: '' } });
    expect(input.a).toBe('${TOKEN}');
  });
});

describe('names', () => {
  it('validates target names', () => {
    expect(() => assertTargetName('github')).not.toThrow();
    expect(() => assertTargetName('my_api.v2-beta')).not.toThrow();
    expect(() => assertTargetName('../etc')).toThrow(CliError);
    expect(() => assertTargetName('a/b')).toThrow(CliError);
    expect(() => assertTargetName('')).toThrow(CliError);
    expect(() => assertTargetName('call')).toThrow(/reserved/);
  });

  it('converts identifiers to kebab-case', () => {
    expect(toKebabCase('listPets')).toBe('list-pets');
    expect(toKebabCase('get_user_by_id')).toBe('get-user-by-id');
    expect(toKebabCase('HTTPServerStatus')).toBe('http-server-status');
    expect(toKebabCase('get /pets/{petId}')).toBe('get-pets-pet-id');
  });

  it('normalizes keys for tolerant matching', () => {
    expect(normalizeKey('pet-id')).toBe(normalizeKey('petId'));
    expect(normalizeKey('PET_ID')).toBe('petid');
  });

  it('finds items by exact name, then by normalized name', () => {
    const items = [{ name: 'search_repositories' }, { name: 'get-file' }];
    expect(findByName(items, 'get-file')?.name).toBe('get-file');
    expect(findByName(items, 'search-repositories')?.name).toBe('search_repositories');
    expect(findByName(items, 'SearchRepositories')?.name).toBe('search_repositories');
    expect(findByName(items, 'nope')).toBeUndefined();
  });
});

describe('fs helpers', () => {
  it('refuses paths inside protected directories, following symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anycli-fs-'));
    const home = join(root, 'home');
    await mkdir(join(home, 'credentials'), { recursive: true });
    await writeFile(join(home, 'config.json'), '{}');
    await symlink(home, join(root, 'link'));
    const protectedDirs = [home];
    await expect(assertOutsideDirs(join(home, 'credentials', 'a.json'), protectedDirs, 'read')).rejects.toMatchObject({ code: 'USAGE' });
    await expect(assertOutsideDirs(home, protectedDirs, 'write')).rejects.toThrow(/Refusing to write/);
    await expect(assertOutsideDirs(join(root, 'link', 'config.json'), protectedDirs, 'read')).rejects.toThrow(/private directory/);
    await expect(assertOutsideDirs(join(root, 'link', 'new', 'file'), protectedDirs, 'write')).rejects.toThrow(/private directory/);
    const realRoot = await realpath(root);
    await expect(assertOutsideDirs(join(root, 'home-other', 'x'), protectedDirs, 'write')).resolves.toBe(join(realRoot, 'home-other', 'x'));
    await expect(assertOutsideDirs(join(root, 'out.bin'), protectedDirs, 'write')).resolves.toBe(join(realRoot, 'out.bin'));
  });

  it('runs critical sections one at a time', async () => {
    const lock = join(await mkdtemp(join(tmpdir(), 'anycli-lock-')), 'x.lock');
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        withFileLock(lock, async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(1);
  });

  it('keeps a held lock fresh so long operations are not mistaken for crashed ones', async () => {
    const lock = join(await mkdtemp(join(tmpdir(), 'anycli-lock-')), 'slow.lock');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await withFileLock(lock, async () => {
        const old = new Date(Date.now() - 60_000);
        await utimes(lock, old, old);
        vi.advanceTimersByTime(5_000);
        await vi.waitFor(async () => expect(Date.now() - (await stat(lock)).mtimeMs).toBeLessThan(10_000));
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
