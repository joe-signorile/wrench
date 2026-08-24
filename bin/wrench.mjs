#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dev } from '../src/commands/dev.mjs';
import { build } from '../src/commands/build.mjs';
import { test } from '../src/commands/test.mjs';
import { infra } from '../src/commands/infra.mjs';
import { deploy } from '../src/commands/deploy.mjs';
import { promote, list } from '../src/commands/promote.mjs';
import { version } from '../src/commands/version.mjs';
import { hasBuildScript, execLegacyBuildScript, confirmNpmFallback } from '../src/lib/detect.mjs';

const [cmd, ...args] = process.argv.slice(2);

const USAGE = `wrench [command]

  (no command)                same as 'deploy' — build + deploy in one step
  dev                        bump version, run tests (non-blocking), start vite
  build [--clean]             tsc/vite build via npm run build, verify dist/, budget check
  test                        npm test
  deploy [--force] [--clean] [--version X.Y.Z]
                               bump version, build, terraform apply, upload, promote
  infra <plan|apply|output> [args...]
                               wrap terraform against infra/
  promote [version]           promote an already-uploaded version
  list                        list deployed versions in S3
  version [bump]               show or bump version.json

In a directory with its own build.sh, every wrench invocation execs that
script directly instead — see README.md.
`;

function printWrenchVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(`wrench ${pkg.version}`);
}

async function dispatch() {
  switch (cmd) {
    case 'dev': return dev();
    case 'build': return build();
    case 'test': return test();
    case 'infra': return infra(args);
    case 'deploy': return deploy(args);
    case 'promote': return promote(args);
    case 'list': return list();
    case 'version': return version(args);
    case undefined:
      return deploy(args);
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

async function main() {
  if (cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === '--version' || cmd === '-v') {
    printWrenchVersion();
    return;
  }

  const cwd = process.cwd();

  if (hasBuildScript(cwd)) {
    return execLegacyBuildScript(cwd, process.argv.slice(2));
  }

  const proceed = await confirmNpmFallback(cwd);
  if (!proceed) {
    console.error('Nothing to do.');
    process.exitCode = 1;
    return;
  }

  return dispatch();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
