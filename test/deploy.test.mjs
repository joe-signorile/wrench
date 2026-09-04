import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpProject, cleanup, fakeBin, runCli, pkg, versionJson } from './helpers.mjs';

after(cleanup);

// Stands in for the whole external toolchain a deploy touches: npm (build),
// terraform (init/apply/output) and python3 (build_tools.py upload/promote).
// terraform and python3 log every invocation to LOGFILE so tests can assert
// on the exact tail — the part deploy() does after build() returns.
function stubs() {
  return {
    npm: 'mkdir -p dist && echo hi > dist/index.html',
    terraform: [
      'echo "terraform $*" >> "$LOGFILE"',
      'eval last=\\${$#}',
      'case "$last" in',
      '  bucket_name) echo test-bucket ;;',
      '  cloudfront_distribution_id) echo E123 ;;',
      'esac',
    ].join('\n'),
    python3: 'shift; echo "python3 $*" >> "$LOGFILE"',
  };
}

test('deploy runs terraform init/apply, then uploads and promotes the built version', async () => {
  const dir = tmpProject({
    'package.json': pkg(null, { scripts: { build: 'true' } }),
    'version.json': versionJson(0, 0, 1),
  });
  const log = join(dir, 'log.txt');
  const restore = fakeBin(stubs());
  try {
    const r = await runCli(dir, ['deploy'], { LOGFILE: log });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.split('\n')[0].trim(), 'v0.0.2');
    const infra = join(realpathSync(dir), 'infra');
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(lines, [
      'terraform -chdir=' + infra + ' init -input=false',
      'terraform -chdir=' + infra + ' apply -auto-approve',
      'terraform -chdir=' + infra + ' output -raw bucket_name',
      'terraform -chdir=' + infra + ' output -raw cloudfront_distribution_id',
      'python3 upload --version 0.0.2',
      'python3 promote --version 0.0.2',
    ]);
  } finally { restore(); }
});

test('--force threads through to the upload call only, not promote', async () => {
  const dir = tmpProject({
    'package.json': pkg(null, { scripts: { build: 'true' } }),
    'version.json': versionJson(0, 0, 1),
  });
  const log = join(dir, 'log.txt');
  const restore = fakeBin(stubs());
  try {
    const r = await runCli(dir, ['deploy', '--force'], { LOGFILE: log });
    assert.equal(r.code, 0, r.stderr);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    const [upload, promote] = lines.slice(-2);
    assert.equal(upload, 'python3 upload --version 0.0.2 --force');
    assert.equal(promote, 'python3 promote --version 0.0.2');
  } finally { restore(); }
});

test('--version pins the uploaded/promoted version instead of bumping', async () => {
  const dir = tmpProject({
    'package.json': pkg(null, { scripts: { build: 'true' } }),
    'version.json': versionJson(0, 0, 1),
  });
  const log = join(dir, 'log.txt');
  const restore = fakeBin(stubs());
  try {
    const r = await runCli(dir, ['deploy', '--version', '9.9.9'], { LOGFILE: log });
    assert.equal(r.code, 0, r.stderr);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    const [upload, promote] = lines.slice(-2);
    assert.equal(upload, 'python3 upload --version 9.9.9');
    assert.equal(promote, 'python3 promote --version 9.9.9');
  } finally { restore(); }
});

test('a failed terraform apply stops the deploy before any upload', async () => {
  const dir = tmpProject({
    'package.json': pkg(null, { scripts: { build: 'true' } }),
    'version.json': versionJson(0, 0, 1),
  });
  const log = join(dir, 'log.txt');
  const restore = fakeBin({
    ...stubs(),
    terraform: '[ "$2" = "apply" ] && exit 1; ' + stubs().terraform,
  });
  try {
    const r = await runCli(dir, ['deploy'], { LOGFILE: log });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /exited with code 1/);
  } finally { restore(); }
});
