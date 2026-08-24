import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { run } from './run.mjs';

export async function execLegacyBuildScript(cwd, args) {
  const script = join(cwd, 'build.sh');
  await run(script, args, { cwd });
}

export async function confirmNpmFallback(cwd) {
  console.log(`No build.sh found in ${cwd}.`);

  if (!process.stdin.isTTY) {
    console.log('Non-interactive session — checking for an npm-based wrench project.');
    return true;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Check for an npm-based wrench project instead? [Y/n] ');
  rl.close();
  return !/^n/i.test(answer.trim());
}

export function hasBuildScript(cwd) {
  return existsSync(join(cwd, 'build.sh'));
}
