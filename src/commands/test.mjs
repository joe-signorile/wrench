import { loadProject } from '../context.mjs';
import { run } from '../lib/run.mjs';

export async function test() {
  const project = loadProject();
  await run('npm', ['test'], { cwd: project.root });
}
