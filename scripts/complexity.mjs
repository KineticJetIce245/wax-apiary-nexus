#!/usr/bin/env node
/**
 * File-length gate for the WAX Apiary neXus repository.
 *
 * Hard limits (AGENTS.md rule 11):
 *   - src/**\/*.ts   : 500 lines
 *   - tests/**\/*.ts : 800 lines
 *
 * Existing violations are recorded in scripts/complexity-baseline.json as the
 * exact line count the file had when it was exempted. An entry may only shrink:
 *
 *   - a file that grows past its entry fails;
 *   - a file that shrinks below its entry fails until the entry is lowered;
 *   - a file that no longer exceeds its hard limit fails until the entry is
 *     removed.
 *
 * That keeps an exemption from becoming permanent headroom. The gate is
 * read-only: it lists and reads files and never writes.
 *
 * Usage:
 *   node scripts/complexity.mjs [--root <dir>] [--baseline <file>]
 *   node scripts/complexity.mjs --help
 *
 * Exit codes: 0 = no violation, 1 = violation or unreadable configuration.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_BASELINE = join(SCRIPT_DIR, 'complexity-baseline.json');

const LIMITS = [
  { dir: 'src', limit: 500 },
  { dir: 'tests', limit: 800 },
];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const SOURCE_EXTENSION = '.ts';

const HELP = `Usage: node scripts/complexity.mjs [--root <dir>] [--baseline <file>]

Checks source and test file lengths against the hard limits:
  src/**/*.ts   ${LIMITS[0].limit} lines
  tests/**/*.ts ${LIMITS[1].limit} lines

Files already over a limit must be listed in the baseline with their exact line
count. Baseline entries may only shrink. Exit code 0 means the gate passed.
`;

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, baseline: DEFAULT_BASELINE, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--root') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error('--root needs a directory');
      }
      options.root = resolve(value);
      index += 1;
    } else if (arg === '--baseline') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error('--baseline needs a file');
      }
      options.baseline = resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown argument '${arg}'`);
    }
  }

  return options;
}

/** Count lines the way an editor does: a trailing newline does not add a line. */
function countLines(text) {
  if (text === '') {
    return 0;
  }
  let newlines = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      newlines += 1;
    }
  }
  return text.endsWith('\n') ? newlines : newlines + 1;
}

function toPosixPath(path) {
  return path.split(sep).join('/');
}

function listTypeScriptFiles(root, dir) {
  const base = join(root, dir);
  if (!existsSync(base)) {
    return [];
  }

  const files = [];
  const walk = (absoluteDir) => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const absolutePath = join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(absolutePath);
        }
      } else if (entry.isFile() && entry.name.endsWith(SOURCE_EXTENSION)) {
        files.push(toPosixPath(relative(root, absolutePath)));
      }
    }
  };
  walk(base);
  return files;
}

function loadBaseline(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read baseline ${file}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`baseline ${file} is not valid JSON: ${error.message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`baseline ${file} must be an object`);
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(`baseline ${file} must declare schemaVersion 1`);
  }

  const files = parsed.files;
  if (files === null || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error(`baseline ${file} must contain a 'files' object`);
  }
  for (const [path, allowed] of Object.entries(files)) {
    if (!Number.isInteger(allowed) || allowed <= 0) {
      throw new Error(
        `baseline ${file}: '${path}' must be a positive integer line count`,
      );
    }
  }

  return files;
}

function limitFor(file) {
  for (const { dir, limit } of LIMITS) {
    if (file === dir || file.startsWith(`${dir}/`)) {
      return limit;
    }
  }
  return undefined;
}

function checkRepository(root, baselineFile) {
  const baseline = loadBaseline(baselineFile);
  const files = LIMITS.flatMap(({ dir }) => listTypeScriptFiles(root, dir)).sort();

  const failures = [];
  const baselined = new Set();

  for (const file of files) {
    const limit = limitFor(file);
    /* c8 ignore next: LIMITS only produces paths limitFor understands */
    if (limit === undefined) {
      continue;
    }

    const lines = countLines(readFileSync(join(root, ...file.split('/')), 'utf8'));
    const allowed = baseline[file];

    if (allowed === undefined) {
      if (lines > limit) {
        failures.push(
          `${file}: ${lines} lines exceeds the ${limit}-line hard limit (no baseline entry)`,
        );
      }
      continue;
    }

    baselined.add(file);

    if (allowed < limit) {
      failures.push(
        `${file}: baseline entry ${allowed} is below the ${limit}-line hard limit; remove it`,
      );
    } else if (lines > allowed) {
      failures.push(
        `${file}: grew from the baselined ${allowed} to ${lines} lines; ` +
          `a baselined file may not grow (hard limit ${limit})`,
      );
    } else if (lines <= limit) {
      failures.push(
        `${file}: no longer exceeds the ${limit}-line hard limit; remove the baseline entry`,
      );
    } else if (lines < allowed) {
      failures.push(
        `${file}: baseline is stale: recorded ${allowed}, actual ${lines}; ` +
          `lower the entry to ${lines} (baseline may only shrink)`,
      );
    }
  }

  for (const file of Object.keys(baseline).sort()) {
    if (!baselined.has(file)) {
      failures.push(`${file}: baseline entry does not match a scanned source or test file; remove it`);
    }
  }

  return { checked: files.length, baselined: baselined.size, failures };
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`complexity: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  let result;
  try {
    result = checkRepository(options.root, options.baseline);
  } catch (error) {
    console.error(`complexity: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (result.failures.length > 0) {
    for (const failure of result.failures) {
      console.error(`complexity: ${failure}`);
    }
    console.error(
      `complexity: failed with ${result.failures.length} violation(s) ` +
        `(${result.checked} files scanned; baseline ${toPosixPath(relative(process.cwd(), options.baseline))})`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `complexity: ok (${result.checked} files scanned, ` +
      `${result.baselined} baselined at recorded bounds; limits src ${LIMITS[0].limit}, tests ${LIMITS[1].limit})`,
  );
}

main(process.argv.slice(2));
