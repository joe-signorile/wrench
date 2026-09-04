import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { terraformOutputs, runBuildTools } from '../src/lib/deploy-env.mjs';
import { UserError } from '../src/lib/errors.mjs';
import { tmpProject, cleanup, fakeBin } from './helpers.mjs';

after(cleanup);

test('terraformOutputs reads bucket and distribution from terraform output -raw', async () => {
  const restore = fakeBin({
    terraform: [
      'eval last=\\${$#}',
      'case "$last" in',
      '  bucket_name) echo test-bucket ;;',
      '  cloudfront_distribution_id) echo E123 ;;',
      'esac',
    ].join('\n'),
  });
  try {
    const outputs = await terraformOutputs('/infra');
    assert.deepEqual(outputs, { bucket: 'test-bucket', distribution: 'E123' });
  } finally { restore(); }
});

test('a terraform failure is a UserError pointing at infra apply', async () => {
  const restore = fakeBin({ terraform: 'exit 1' });
  try {
    await assert.rejects(
      terraformOutputs('/infra'),
      (e) => e instanceof UserError && /wrench infra apply/.test(e.message),
    );
  } finally { restore(); }
});

test('an empty terraform output is a UserError naming the blank output', async () => {
  const restore = fakeBin({
    terraform: [
      'eval last=\\${$#}',
      'case "$last" in',
      '  bucket_name) echo test-bucket ;;',
      '  cloudfront_distribution_id) printf "" ;;',
      'esac',
    ].join('\n'),
  });
  try {
    await assert.rejects(
      terraformOutputs('/infra'),
      (e) => e instanceof UserError && /cloudfront_distribution_id.*empty/s.test(e.message),
    );
  } finally { restore(); }
});

test('runBuildTools execs python3 against build_tools.py, in the project root, with the given env', async () => {
  const dir = tmpProject();
  const log = join(dir, 'log.txt');
  const restore = fakeBin({ python3: 'shift; echo "$@" >> "$LOGFILE"; pwd >> "$LOGFILE"' });
  try {
    await runBuildTools({ root: dir }, { ...process.env, LOGFILE: log, MARKER: 'x' }, ['list']);
    const [args, cwd] = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(args, 'list');
    assert.match(cwd, new RegExp(`${dir}$`));
  } finally { restore(); }
});
