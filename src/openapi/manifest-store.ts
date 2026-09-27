import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from '../core/errors.js';
import { isNotFound, writeFileAtomic } from '../core/fs.js';
import type { OpenApiManifest } from './compile.js';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function manifestPath(cacheDir: string, name: string): string {
  if (!SAFE_NAME.test(name) || name.includes('..')) throw new CliError('USAGE', `Invalid target name "${name}"`);
  return join(cacheDir, `${name}.openapi.json`);
}

export async function writeManifest(cacheDir: string, name: string, manifest: OpenApiManifest): Promise<void> {
  await writeFileAtomic(manifestPath(cacheDir, name), JSON.stringify(manifest));
}

export async function readManifest(cacheDir: string, name: string): Promise<OpenApiManifest | undefined> {
  try {
    return JSON.parse(await readFile(manifestPath(cacheDir, name), 'utf8')) as OpenApiManifest;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new CliError('CONFIG', `Cached spec for "${name}" is unreadable: ${(error as Error).message}`, {
      hint: `Run \`anycli refresh ${name}\``,
    });
  }
}

export async function removeManifest(cacheDir: string, name: string): Promise<void> {
  await rm(manifestPath(cacheDir, name), { force: true });
}
