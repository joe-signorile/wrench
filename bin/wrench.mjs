#!/usr/bin/env node
import { dev } from '../src/commands/dev.mjs';
import { build } from '../src/commands/build.mjs';
import { test } from '../src/commands/test.mjs';
import { infra } from '../src/commands/infra.mjs';
import { deploy } from '../src/commands/deploy.mjs';
import { promote, list } from '../src/commands/promote.mjs';
import { version } from '../src/commands/version.mjs';

const [cmd, ...args] = process.argv.slice(2);

const USAGE = `wrench <command>

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
`;

async function main() {
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
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
