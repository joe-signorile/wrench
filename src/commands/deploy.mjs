import { join } from 'node:path';
import { loadProject, wrenchRoot } from '../context.mjs';
import { bumpVersion, formatVersion } from '../lib/version-file.mjs';
import { run, runCapture } from '../lib/run.mjs';
import { build } from './build.mjs';

function parseFlags(args) {
  const flags = { force: false, clean: false, version: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force') flags.force = true;
    else if (args[i] === '--clean') flags.clean = true;
    else if (args[i] === '--version') flags.version = args[++i];
  }
  return flags;
}

export async function deploy(args) {
  const flags = parseFlags(args);
  const project = loadProject();
  const infraDir = join(project.root, 'infra');

  let version = flags.version;
  if (!version) {
    const v = bumpVersion(project.root);
    version = formatVersion(v);
  }
  console.log(`v${version}`);

  await build();

  await run('terraform', [`-chdir=${infraDir}`, 'init', '-input=false']);
  await run('terraform', [`-chdir=${infraDir}`, 'apply', '-auto-approve']);

  const bucket = await runCapture('terraform', [`-chdir=${infraDir}`, 'output', '-raw', 'bucket_name']);
  const distribution = await runCapture('terraform', [`-chdir=${infraDir}`, 'output', '-raw', 'cloudfront_distribution_id']);

  const env = {
    ...process.env,
    WRENCH_PROJECT_ROOT: project.root,
    WRENCH_S3_BUCKET: bucket,
    WRENCH_CF_DISTRIBUTION: distribution,
    WRENCH_DISPLAY_NAME: project.displayName,
    WRENCH_ACCENT_COLOR: project.accentColor,
  };

  const buildTools = join(wrenchRoot, 'python', 'build_tools.py');
  const uploadArgs = ['upload', '--version', version];
  if (flags.force) uploadArgs.push('--force');
  await run('python3', [buildTools, ...uploadArgs], { cwd: project.root, env });

  await run('python3', [buildTools, 'promote', '--version', version], { cwd: project.root, env });
}
