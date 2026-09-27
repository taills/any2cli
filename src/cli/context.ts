import { openBrowser } from '../auth/browser.js';
import { resolvePaths, type Paths } from '../config/paths.js';
import { loadConfig, type LoadedConfig } from '../config/store.js';
import type { Io } from './output.js';
import { Printer } from './output.js';

export interface GlobalOptions {
  config?: string;
  json?: boolean;
  pretty?: boolean;
  verbose?: boolean;
}

export interface Runtime {
  io: Io;
  env: NodeJS.ProcessEnv;
  cwd: string;
  openUrl: (url: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  readStdin?: () => Promise<string>;
}

export interface Context {
  runtime: Runtime;
  globals: GlobalOptions;
  printer: Printer;
  paths: Paths;
  loadConfig(): Promise<LoadedConfig>;
}

export function defaultRuntime(): Runtime {
  return {
    io: { stdout: process.stdout, stderr: process.stderr, stdoutIsTTY: process.stdout.isTTY === true },
    env: process.env,
    cwd: process.cwd(),
    openUrl: (url) => openBrowser(url),
  };
}

export function createContext(runtime: Runtime, globals: GlobalOptions): Context {
  const paths = resolvePaths({ env: runtime.env, cwd: runtime.cwd, configOverride: globals.config });
  return {
    runtime,
    globals,
    paths,
    printer: new Printer(runtime.io, { json: globals.json === true, pretty: globals.pretty === true }),
    loadConfig: () => loadConfig(paths.configFile),
  };
}
