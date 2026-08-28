import { join } from 'node:path';
import { wrenchRoot } from '../context.mjs';
import { run, runCapture } from './run.mjs';
import { loadWrenchConfig } from './wrench-config.mjs';
import { UserError } from './errors.mjs';

export function infraDir(project) {
  return join(project.root, 'infra');
}

// An empty terraform output is the dangerous case: a blank distribution id
// used to make build_tools skip CloudFront invalidation entirely, so the
// deploy "succeeded" while the CDN kept serving the previous version.
export async function terraformOutputs(dir) {
  let bucket, distribution;
  try {
    bucket = await runCapture('terraform', [`-chdir=${dir}`, 'output', '-raw', 'bucket_name']);
    distribution = await runCapture('terraform', [`-chdir=${dir}`, 'output', '-raw', 'cloudfront_distribution_id']);
  } catch (err) {
    throw new UserError(`${err.message}\nRun 'wrench infra apply' first.`);
  }
  for (const [name, value] of [['bucket_name', bucket], ['cloudfront_distribution_id', distribution]]) {
    if (!value) {
      throw new UserError(
        `terraform output '${name}' in ${dir} is empty. Run 'wrench infra apply' and check infra/outputs.tf.`
      );
    }
  }
  return { bucket, distribution };
}

export function buildDeployEnv(project, { bucket, distribution }, config = loadWrenchConfig()) {
  const env = {
    ...process.env,
    WRENCH_PROJECT_ROOT: project.root,
    WRENCH_S3_BUCKET: bucket,
    WRENCH_CF_DISTRIBUTION: distribution,
    WRENCH_DISPLAY_NAME: project.displayName,
    WRENCH_ACCENT_COLOR: project.accentColor,
    WRENCH_PROJECT_NAME: project.name || '',
    WRENCH_ROOT_DOMAIN: config.rootDomain || '',
    WRENCH_REGISTRY_BUCKET: config.registryBucket || '',
  };

  // null means "no custom-domain wiring", "" means "the apex". Collapsing both
  // to "" made unmigrated sites claim the apex URL in the shared registry, so
  // absent is encoded by leaving the variable unset entirely.
  if (project.subdomain === null) delete env.WRENCH_SUBDOMAIN;
  else env.WRENCH_SUBDOMAIN = project.subdomain;

  return env;
}

export function runBuildTools(project, env, args) {
  const buildTools = join(wrenchRoot, 'python', 'build_tools.py');
  return run('python3', [buildTools, ...args], { cwd: project.root, env });
}
