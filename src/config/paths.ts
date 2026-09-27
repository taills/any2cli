import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const PROJECT_CONFIG_FILE = '.any2cli.json';

export interface Paths {
  home: string;
  configFile: string;
  credentialsDir: string;
  cacheDir: string;
}

export interface ResolvePathsOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  configOverride?: string;
  exists?: (path: string) => boolean;
}

/**
 * Config lookup order: `--config` flag, `ANY2CLI_CONFIG`, `./.any2cli.json`, then `<home>/config.json`.
 * Home is `ANY2CLI_HOME` or `$XDG_CONFIG_HOME/any2cli` (default `~/.config/any2cli`).
 */
export function resolvePaths(options: ResolvePathsOptions = {}): Paths {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const exists = options.exists ?? existsSync;
  const home = env.ANY2CLI_HOME
    ? resolve(env.ANY2CLI_HOME)
    : join(env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : join(homedir(), '.config'), 'any2cli');
  const projectFile = join(cwd, PROJECT_CONFIG_FILE);
  const configFile = options.configOverride
    ? resolve(cwd, options.configOverride)
    : env.ANY2CLI_CONFIG
      ? resolve(cwd, env.ANY2CLI_CONFIG)
      : exists(projectFile)
        ? projectFile
        : join(home, 'config.json');
  return { home, configFile, credentialsDir: join(home, 'credentials'), cacheDir: join(home, 'cache') };
}
