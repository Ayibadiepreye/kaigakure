import { spawn } from 'node:child_process';

/**
 * Run a command, capture stdout/stderr, never throw.
 * Resolves { code, stdout, stderr, timedOut }.
 */
export function run(cmd, args, opts = {}) {
  const { timeout = 120000, cwd, env } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, ...env },
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err), timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill(); } catch { /* already dead */ }
        }, timeout)
      : null;

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut });
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
