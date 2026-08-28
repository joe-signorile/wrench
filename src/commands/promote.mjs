import { loadProject } from '../context.mjs';
import { readVersion, formatVersion, assertSemver } from '../lib/version-file.mjs';
import { UserError } from '../lib/errors.mjs';
import { infraDir, terraformOutputs, buildDeployEnv, runBuildTools } from '../lib/deploy-env.mjs';

async function deployEnv(project) {
  const dir = infraDir(project);
  return buildDeployEnv(project, await terraformOutputs(dir));
}

export async function promote(args = []) {
  if (args.length > 1) throw new UserError(`Usage: wrench promote [version]`);
  const project = loadProject(process.cwd(), { requireVersion: args.length === 0 });
  const version = args[0] ? assertSemver(args[0]) : formatVersion(readVersion(project.root));
  const env = await deployEnv(project);
  await runBuildTools(project, env, ['promote', '--version', version]);
}

export async function list(args = []) {
  if (args.length) throw new UserError(`Usage: wrench list`);
  const project = loadProject();
  const env = await deployEnv(project);
  await runBuildTools(project, env, ['list']);
}
