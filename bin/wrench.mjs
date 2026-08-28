#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dev } from '../src/commands/dev.mjs';
import { build, parseBuildFlags } from '../src/commands/build.mjs';
import { test } from '../src/commands/test.mjs';
import { infra } from '../src/commands/infra.mjs';
import { deploy } from '../src/commands/deploy.mjs';
import { promote, list } from '../src/commands/promote.mjs';
import { version } from '../src/commands/version.mjs';
import { hasBuildScript, execLegacyBuildScript } from '../src/lib/detect.mjs';
import { UserError } from '../src/lib/errors.mjs';

const USAGE = `wrench [command]

  (no command)                same as 'deploy' — build + deploy in one step
  dev                         bump version, run tests (non-blocking), start vite
  build [--clean]             npm run build, verify dist/, budget check
  test                        npm test
  deploy [--force] [--clean] [--version X.Y.Z]
                              bump version, build, terraform apply, upload, promote
  infra <plan|apply|output> [args...]
                              wrap terraform against infra/
  promote [version]           promote an already-uploaded version
  list                        list deployed versions in S3
  version [bump]              show or bump version.json

In a directory with its own build.sh, every wrench invocation execs that
script directly instead — see README.md.
`;

function printWrenchVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(`wrench ${pkg.version}`);
}

async function dispatch(cmd, args) {
  switch (cmd) {
    case undefined:
    case 'deploy': return deploy(args);
    case 'dev': return dev(args);
    case 'build': return build(parseBuildFlags(args));
    case 'test': return test(args);
    case 'infra': return infra(args);
    case 'promote': return promote(args);
    case 'list': return list(args);
    case 'version': return version(args);
    default:
      throw new UserError(`Unknown command: ${cmd}\n\n${USAGE}`);
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === '--help' || cmd === '-h') return void process.stdout.write(USAGE);
  if (cmd === '--version' || cmd === '-v') return printWrenchVersion();

  const cwd = process.cwd();

  // Three-way detection, in priority order. A wrench-native project must not
  // have to answer a prompt on the happy path of every deploy.
  if (hasBuildScript(cwd)) return execLegacyBuildScript(cwd, process.argv.slice(2));

  if (!existsSync(join(cwd, 'package.json'))) {
    throw new UserError(
      `Nothing to do in ${cwd}: no build.sh and no package.json.\n\n${USAGE}`
    );
  }

  return dispatch(cmd, args);
}

main().catch((err) => {
  // A UserError carries a message written for the user. Anything else is a bug
  // in wrench, and the stack is the whole point.
  if (err instanceof UserError) console.error(err.message);
  else console.error(err?.stack || err);
  process.exitCode = 1;
});
