import { loadProject } from '../context.mjs';
import { readVersion, bumpVersion, formatVersion } from '../lib/version-file.mjs';

export function version(args) {
  const project = loadProject();
  if (args[0] === 'bump') {
    const v = bumpVersion(project.root);
    console.log(`v${formatVersion(v)}`);
  } else {
    console.log(`v${formatVersion(readVersion(project.root))}`);
  }
}
