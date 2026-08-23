import { join } from 'node:path';
import { loadProject } from '../context.mjs';
import { run } from '../lib/run.mjs';

export async function infra(subArgs) {
  const project = loadProject();
  const infraDir = join(project.root, 'infra');
  const [cmd, ...rest] = subArgs;

  if (!cmd || !['plan', 'apply', 'output'].includes(cmd)) {
    throw new Error(`Usage: wrench infra <plan|apply|output> [args...]`);
  }

  await run('terraform', [`-chdir=${infraDir}`, 'init', '-input=false']);

  if (cmd === 'apply') {
    await run('terraform', [`-chdir=${infraDir}`, 'apply', '-auto-approve', ...rest]);
  } else if (cmd === 'plan') {
    await run('terraform', [`-chdir=${infraDir}`, 'plan', ...rest]);
  } else if (cmd === 'output') {
    await run('terraform', [`-chdir=${infraDir}`, 'output', ...rest]);
  }
}
