import { loadProject } from '../context.mjs';
import { run } from '../lib/run.mjs';
import { UserError } from '../lib/errors.mjs';

export async function test(args = []) {
  if (args.length) throw new UserError(`Usage: wrench test`);
  const project = loadProject();
  await run('npm', ['test'], { cwd: project.root });
}
