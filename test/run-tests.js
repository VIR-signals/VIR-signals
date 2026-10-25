// Test runner: compile src and tests, run node:test over the compiled
// test files, then write the three part report under reports/<stamp>/.
// Report parts: results.json, console.txt, summary.md.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportDir = path.join(root, 'reports', stamp);
fs.mkdirSync(reportDir, { recursive: true });

const tsc = path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js');
if (!fs.existsSync(tsc)) {
  console.error('typescript is not installed under node_modules');
  process.exit(1);
}

const compile = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.test.json'], {
  cwd: root,
  encoding: 'utf8',
});
if (compile.status !== 0) {
  console.error(compile.stdout);
  console.error(compile.stderr);
  process.exit(compile.status === null ? 1 : compile.status);
}

const testRun = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'out-test/test/*.test.js'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const consoleText = [testRun.stdout, testRun.stderr].join('\n');
fs.writeFileSync(path.join(reportDir, 'console.txt'), consoleText);

const results = parseTap(consoleText);
results.stamp = stamp;
results.exitCode = testRun.status === null ? 1 : testRun.status;
fs.writeFileSync(path.join(reportDir, 'results.json'), JSON.stringify(results, null, 2));
fs.writeFileSync(path.join(reportDir, 'summary.md'), renderSummary(results));
console.log(renderSummary(results));

if (results.exitCode !== 0) {
  process.exit(results.exitCode);
}

function parseTap(text) {
  const cases = [];
  const totals = {};
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const caseMatch = /^(\s*)(not )?ok \d+ - (.*)$/.exec(line);
    if (caseMatch) {
      cases.push({
        depth: Math.floor(caseMatch[1].length / 4),
        ok: caseMatch[2] === undefined,
        name: caseMatch[3],
      });
      continue;
    }
    const totalMatch = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (totalMatch) {
      totals[totalMatch[1]] = Number(totalMatch[2]);
    }
  }
  return { cases, totals };
}

function renderSummary(results) {
  const failed = results.cases.filter((c) => !c.ok);
  const lines = [];
  lines.push('# test report ' + results.stamp);
  lines.push('');
  lines.push('- exit code: ' + results.exitCode);
  for (const key of Object.keys(results.totals)) {
    lines.push('- ' + key + ': ' + results.totals[key]);
  }
  lines.push('');
  if (failed.length === 0) {
    lines.push('all green');
  } else {
    lines.push('failed cases:');
    for (const c of failed) {
      lines.push('- ' + c.name);
    }
  }
  return lines.join('\n') + '\n';
}
