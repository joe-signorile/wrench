import { loadProject } from '../context.mjs';
import { bumpVersion, setVersion, formatVersion, assertSemver } from '../lib/version-file.mjs';
import { run } from '../lib/run.mjs';
import { UserError } from '../lib/errors.mjs';
import { infraDir, terraformOutputs, buildDeployEnv, runBuildTools } from '../lib/deploy-env.mjs';
import { build } from './build.mjs';

export function parseFlags(args = []) {
  const flags = { force: false, clean: false, version: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--force') flags.force = true;
    else if (arg === '--clean') flags.clean = true;
    else if (arg === '--version') {
      const value = args[++i];
      if (value === undefined) throw new UserError('--version needs a value (X.Y.Z).');
      flags.version = value;
    } else {
      throw new UserError(`Unknown argument for 'wrench deploy': ${arg}`);
    }
  }
  if (flags.version) assertSemver(flags.version, '--version');
  return flags;
}

export async function deploy(args) {
  const flags = parseFlags(args);
  const project = loadProject(process.cwd(), { requireVersion: true });
  const dir = infraDir(project);

  // The build embeds version.json, so an explicit --version has to be written
  // there before building — otherwise the built assets and the S3 prefix they
  // land under disagree.
  const v = flags.version ? setVersion(project.root, flags.version) : bumpVersion(project.root);
  const version = formatVersion(v);
  console.log(`v${version}`);

  await build({ clean: flags.clean }, project);

  await run('terraform', [`-chdir=${dir}`, 'init', '-input=false']);
  await run('terraform', [`-chdir=${dir}`, 'apply', '-auto-approve']);

  const env = buildDeployEnv(project, await terraformOutputs(dir));

  const uploadArgs = ['upload', '--version', version];
  if (flags.force) uploadArgs.push('--force');
  await runBuildTools(project, env, uploadArgs);

  await runBuildTools(project, env, ['promote', '--version', version]);
}
