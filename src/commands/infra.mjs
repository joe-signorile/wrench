import { loadProject } from '../context.mjs';
import { run } from '../lib/run.mjs';
import { UserError } from '../lib/errors.mjs';
import { infraDir } from '../lib/deploy-env.mjs';

const SUBCOMMANDS = ['plan', 'apply', 'output'];

export async function infra(subArgs = []) {
  const [cmd, ...rest] = subArgs;
  if (!cmd || !SUBCOMMANDS.includes(cmd)) {
    throw new UserError(`Usage: wrench infra <${SUBCOMMANDS.join('|')}> [args...]`);
  }

  const project = loadProject();
  const dir = infraDir(project);

  await run('terraform', [`-chdir=${dir}`, 'init', '-input=false']);

  const extra = cmd === 'apply' ? ['-auto-approve'] : [];
  await run('terraform', [`-chdir=${dir}`, cmd, ...extra, ...rest]);
}
