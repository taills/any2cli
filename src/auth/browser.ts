import { spawn } from 'node:child_process';
import open from 'open';

function isHeadless(env: NodeJS.ProcessEnv): boolean {
  if (process.platform !== 'linux') return false;
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

/**
 * Opens a URL in the user's browser. Honours `ANY2CLI_NO_BROWSER=1` and the conventional
 * `BROWSER` variable. Returns false when no browser could be launched so callers can fall back
 * to printing the URL.
 */
export async function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (env.ANY2CLI_NO_BROWSER === '1' || env.ANY2CLI_NO_BROWSER === 'true') return false;
  if (env.BROWSER) {
    return new Promise((resolve) => {
      const child = spawn(env.BROWSER as string, [url], { stdio: 'ignore', detached: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    });
  }
  if (isHeadless(env)) return false;
  try {
    const child = await open(url);
    child.once('error', () => undefined);
    return true;
  } catch {
    return false;
  }
}
