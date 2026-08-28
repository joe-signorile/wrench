import { spawn } from 'node:child_process';
import { UserError } from './errors.mjs';

const INSTALL_HINTS = {
  terraform: 'install it: https://developer.hashicorp.com/terraform/install',
  python3: 'install it: https://www.python.org/downloads/',
  vite: "it isn't in this project's node_modules — run 'npm install'",
};

function hintFor(cmd) {
  // dev spawns node_modules/.bin/vite by absolute path; key off the basename.
  return INSTALL_HINTS[cmd] || INSTALL_HINTS[cmd.split('/').pop()];
}

function friendlyError(cmd, err) {
  if (err.code === 'ENOENT') {
    const hint = hintFor(cmd);
    return new UserError(`Command not found: ${cmd}${hint ? ` — ${hint}` : ''}`);
  }
  if (err.code === 'EACCES') {
    return new UserError(`Permission denied running ${cmd} — check it's executable (chmod +x).`);
  }
  return err;
}

function settle(cmd, args, child, resolvePromise, reject, value) {
  child.on('error', (err) => reject(friendlyError(cmd, err)));
  child.on('close', (code, signal) => {
    if (signal) return reject(new UserError(`${cmd} killed by signal ${signal}`));
    if (code !== 0) return reject(new UserError(`${cmd} ${args.join(' ')} exited with code ${code}`));
    resolvePromise(value());
  });
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    settle(cmd, args, child, resolvePromise, reject, () => undefined);
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
    // Decode as a stream: concatenating raw Buffers would corrupt any
    // multi-byte character that straddles a chunk boundary.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    settle(cmd, args, child, resolvePromise, reject, () => stdout.trim());
  });
}
