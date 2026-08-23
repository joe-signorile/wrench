import { spawn } from 'node:child_process';

export function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) return reject(new Error(`${cmd} killed by signal ${signal}`));
      if (code !== 0) return reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
      resolvePromise();
    });
  });
}

export async function runBestEffort(cmd, args, opts = {}) {
  try {
    await run(cmd, args, opts);
  } catch {
    // swallowed — caller wants best-effort semantics (e.g. `npm test` before `dev`)
  }
}

export function runCapture(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'inherit'], ...opts });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) return reject(new Error(`${cmd} killed by signal ${signal}`));
      if (code !== 0) return reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
      resolvePromise(stdout.trim());
    });
  });
}
