import { existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const dist = resolve('dist');

// TypeScript does not remove compiled files for deleted sources. Move the
// previous output aside so an old test file can never run after its source was
// deleted. This is a move, not a recursive delete.
if (existsSync(dist)) {
  const archive = join(
    tmpdir(),
    `wax-apiary-nexus-dist-${Date.now()}-${process.pid}`,
  );
  renameSync(dist, archive);
}

const build = spawnSync('npm', ['run', 'build'], {
  stdio: 'inherit',
  shell: true,
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const tests = spawnSync('node', ['--test', 'dist/tests/*.test.js'], {
  stdio: 'inherit',
  shell: true,
});
process.exit(tests.status ?? 1);
