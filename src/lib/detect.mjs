import { statSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { run } from './run.mjs';
import { UserError } from './errors.mjs';

export function buildScriptPath(cwd) {
  return join(cwd, 'build.sh');
}

// True only for a real, executable build.sh. A directory or a non-executable
// file named build.sh is not a passthrough target — say so rather than
// failing later inside spawn.
export function hasBuildScript(cwd) {
  const script = buildScriptPath(cwd);
  let st;
  try {
    st = statSync(script);
  } catch {
    return false;
  }
  if (!st.isFile()) {
    throw new UserError(`${script} exists but is not a regular file.`);
  }
  try {
    accessSync(script, constants.X_OK);
  } catch {
    throw new UserError(`${script} is not executable — run 'chmod +x ${script}'.`);
  }
  return true;
}

// Full passthrough: wrench does not inspect this script, it just runs it.
// Announce the resolved path first, since this hands control to an arbitrary
// executable found in whatever directory wrench was invoked from.
export async function execLegacyBuildScript(cwd, args) {
  const script = buildScriptPath(cwd);
  console.log(`exec ${script}`);
  await run(script, args, { cwd });
}
