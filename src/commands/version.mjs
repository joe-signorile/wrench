import { loadProject } from '../context.mjs';
import { readVersion, bumpVersion, formatVersion } from '../lib/version-file.mjs';
import { UserError } from '../lib/errors.mjs';

export function version(args = []) {
  if (args.length > 1 || (args.length === 1 && args[0] !== 'bump')) {
    throw new UserError(`Usage: wrench version [bump]`);
  }
  const project = loadProject(process.cwd(), { requireVersion: true });
  const v = args[0] === 'bump' ? bumpVersion(project.root) : readVersion(project.root);
  console.log(`v${formatVersion(v)}`);
}
