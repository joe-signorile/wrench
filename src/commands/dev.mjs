import { join } from 'node:path';
import { loadProject } from '../context.mjs';
import { bumpVersion, formatVersion } from '../lib/version-file.mjs';
import { run, runBestEffort } from '../lib/run.mjs';

export async function dev() {
  const project = loadProject();
  const v = bumpVersion(project.root);
  console.log(`v${formatVersion(v)}`);

  await runBestEffort('npm', ['test'], { cwd: project.root });

  const vite = join(project.root, 'node_modules', '.bin', 'vite');
  await run(vite, [], { cwd: project.root });
}
