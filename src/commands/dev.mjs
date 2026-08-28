import { join } from 'node:path';
import { loadProject } from '../context.mjs';
import { bumpVersion, formatVersion } from '../lib/version-file.mjs';
import { run, runBestEffort } from '../lib/run.mjs';
import { UserError } from '../lib/errors.mjs';

export async function dev(args = []) {
  if (args.length) throw new UserError(`Usage: wrench dev`);
  const project = loadProject(process.cwd(), { requireVersion: true });
  const v = bumpVersion(project.root);
  console.log(`v${formatVersion(v)}`);

  await runBestEffort('npm', ['test'], { cwd: project.root });

  const vite = join(project.root, 'node_modules', '.bin', 'vite');
  await run(vite, [], { cwd: project.root });
}
