import { join } from 'node:path';
import { loadProject, wrenchRoot } from '../context.mjs';
import { readVersion, formatVersion } from '../lib/version-file.mjs';
import { run, runCapture } from '../lib/run.mjs';

async function deployEnv(project) {
  const infraDir = join(project.root, 'infra');
  const bucket = await runCapture('terraform', [`-chdir=${infraDir}`, 'output', '-raw', 'bucket_name']);
  const distribution = await runCapture('terraform', [`-chdir=${infraDir}`, 'output', '-raw', 'cloudfront_distribution_id']);
  return {
    ...process.env,
    WRENCH_PROJECT_ROOT: project.root,
    WRENCH_S3_BUCKET: bucket,
    WRENCH_CF_DISTRIBUTION: distribution,
    WRENCH_DISPLAY_NAME: project.displayName,
    WRENCH_ACCENT_COLOR: project.accentColor,
  };
}

export async function promote(args) {
  const project = loadProject();
  const version = args[0] || formatVersion(readVersion(project.root));
  const env = await deployEnv(project);
  const buildTools = join(wrenchRoot, 'python', 'build_tools.py');
  await run('python3', [buildTools, 'promote', '--version', version], { cwd: project.root, env });
}

export async function list() {
  const project = loadProject();
  const env = await deployEnv(project);
  const buildTools = join(wrenchRoot, 'python', 'build_tools.py');
  await run('python3', [buildTools, 'list'], { cwd: project.root, env });
}
