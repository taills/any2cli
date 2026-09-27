import type { Writable } from 'node:stream';
import { FileMcpOAuthProvider } from '../auth/mcp-provider.js';
import { resolveAuthMaterial } from '../auth/resolve.js';
import { CredentialStore } from '../auth/token-store.js';
import type { Paths } from '../config/paths.js';
import type { OpenApiTarget, Target } from '../config/schema.js';
import type { TargetAdapter } from '../core/types.js';
import { openMcpAdapter } from '../mcp/adapter.js';
import { openOpenApiAdapter } from '../openapi/adapter.js';
import { compileSpec, MANIFEST_VERSION, type OpenApiManifest } from '../openapi/compile.js';
import { loadSpec } from '../openapi/load.js';
import { readManifest, writeManifest } from '../openapi/manifest-store.js';

export interface OpenTargetDeps {
  paths: Paths;
  /** Receives the stdio server's stderr live (for --verbose). */
  serverStderr?: Writable;
  fetchImpl?: typeof fetch;
}

/** Loads the OpenAPI spec, compiles it and caches the manifest (used by `add` and `refresh`). */
export async function compileOpenApiTarget(name: string, target: OpenApiTarget, paths: Paths): Promise<OpenApiManifest> {
  const manifest = compileSpec(await loadSpec(target.spec), { source: target.spec, include: target.include, exclude: target.exclude });
  await writeManifest(paths.cacheDir, name, manifest);
  return manifest;
}

/** anycli's own files: tool uploads and --save must never read or overwrite them. */
export function protectedPaths(paths: Paths): string[] {
  return [paths.home, paths.configFile, paths.credentialsDir, paths.cacheDir];
}

async function loadManifest(name: string, target: OpenApiTarget, paths: Paths): Promise<OpenApiManifest> {
  const cached = await readManifest(paths.cacheDir, name);
  return cached?.version === MANIFEST_VERSION ? cached : compileOpenApiTarget(name, target, paths);
}

export async function openTarget(name: string, target: Target, deps: OpenTargetDeps): Promise<TargetAdapter> {
  const store = new CredentialStore(deps.paths.credentialsDir);
  const resolveDeps = { store, fetchImpl: deps.fetchImpl };
  const protectedDirs = protectedPaths(deps.paths);

  if (target.type === 'stdio') {
    return openMcpAdapter({ name, target, stderr: deps.serverStderr, protectedDirs });
  }
  if (target.type === 'http' || target.type === 'sse') {
    const authProvider =
      target.auth?.type === 'mcp-oauth'
        ? await FileMcpOAuthProvider.create({ name, config: target.auth, store, interactive: false })
        : undefined;
    const material = await resolveAuthMaterial(name, target.auth, resolveDeps);
    return openMcpAdapter({ name, target, headers: material.headers, query: material.query, authProvider, protectedDirs });
  }
  const manifest = await loadManifest(name, target, deps.paths);
  return openOpenApiAdapter({
    name,
    target,
    manifest,
    resolveAuth: (forceRefresh) => resolveAuthMaterial(name, target.auth, resolveDeps, forceRefresh),
    canRefresh: target.auth?.type === 'oauth2',
    fetchImpl: deps.fetchImpl,
    protectedDirs,
  });
}
