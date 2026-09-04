import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadProject } from '../context.mjs';
import { bumpVersion, formatVersion } from '../lib/version-file.mjs';
import { run, runBestEffort } from '../lib/run.mjs';
import { UserError } from '../lib/errors.mjs';

function hasDevScript(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return Boolean(pkg.scripts?.dev);
}

export async function dev(args = []) {
  if (args.length) throw new UserError(`Usage: wrench dev`);
  const project = loadProject(process.cwd(), { requireVersion: true });
  const v = bumpVersion(project.root);
  console.log(`v${formatVersion(v)}`);

  await runBestEffort('npm', ['test'], { cwd: project.root });

  if (!hasDevScript(project.root)) {
    throw new UserError(`No "dev" script in package.json — add one (e.g. "dev": "vite").`);
  }
  await run('npm', ['run', 'dev'], { cwd: project.root });
}
