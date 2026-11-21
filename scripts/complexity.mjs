#!/usr/bin/env node
/**
 * Complexity gate for the WAX Apiary neXus repository.
 *
 * Two independent gates run against the same scanned files:
 *
 * 1. File length (AGENTS.md rule 11):
 *      src/**\/*.ts   : 500 lines
 *      tests/**\/*.ts : 800 lines
 *
 * 2. Function/class metrics (AGENTS.md rule 11), parsed with the installed
 *    TypeScript compiler API. TypeScript 7 exposes its parser through
 *    `typescript/unstable/sync`; using it keeps the gate on the repository's
 *    existing dependency instead of adding a second parser.
 *      functions/methods : lines <= 50, cyclomatic <= 10, nesting <= 4,
 *                          parameters <= 6
 *      classes           : body lines <= 250, public methods <= 12,
 *                          constructor dependencies <= 8
 *
 * Metric definitions (all measured on the real AST, not on text):
 *
 *   - function lines: first line of the declaration through the closing brace
 *     (or the full arrow expression), inclusive.
 *   - cyclomatic: 1 + if / for / for-in / for-of / while / do / case / catch /
 *     conditional expression / each &&, ||, ??, &&=, ||=, ??= in the body.
 *     Decisions inside nested functions and classes are excluded; those are
 *     measured as their own declarations.
 *   - nesting: maximum depth of nested control statements (if, for, for-in,
 *     for-of, while, do, switch, try) inside the body. The body itself starts
 *     at depth 0. A try counts once for the try/catch/finally group; catch does
 *     not add another level. Case clauses do not add nesting.
 *   - parameters: declared parameters; a rest parameter counts as one.
 *   - class body lines: opening brace line through closing brace line, inclusive.
 *   - public methods: public (not `private`, `protected`, or `#name`) method,
 *     getter, and setter declarations; constructors are excluded.
 *   - constructor dependencies: parameter count of the widest constructor.
 *
 * Existing file and metric violations are recorded in their baseline files at
 * the exact observed value. A baseline entry may only shrink:
 *
 *   - a declaration/file that grows past its entry fails;
 *   - a declaration/file that shrinks below its entry fails until the entry is
 *     lowered;
 *   - an entry that no longer exceeds any hard limit fails until it is removed.
 *
 * That keeps an exemption from becoming permanent headroom. The gate is
 * read-only: it lists and reads files and never writes.
 *
 * Usage:
 *   node scripts/complexity.mjs [--root <dir>] [--baseline <file>]
 *                               [--metrics-baseline <file>]
 *                               [--print-metrics-baseline]
 *   node scripts/complexity.mjs --help
 *
 * `--print-metrics-baseline` prints the baseline that would cover the current
 * metric violations; it never writes a file. Exit codes: 0 = no violation,
 * 1 = violation or unreadable configuration.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyntaxKind } from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_BASELINE = join(SCRIPT_DIR, 'complexity-baseline.json');
const METRICS_BASELINE_NAME = 'complexity-metrics-baseline.json';

const LIMITS = [
  { dir: 'src', limit: 500 },
  { dir: 'tests', limit: 800 },
];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const SOURCE_EXTENSION = '.ts';

const FUNCTION_LIMITS = {
  lines: 50,
  cyclomatic: 10,
  nesting: 4,
  parameters: 6,
};
const CLASS_LIMITS = {
  bodyLines: 250,
  publicMethods: 12,
  constructorDependencies: 8,
};
const FUNCTION_FIELDS = Object.keys(FUNCTION_LIMITS);
const CLASS_FIELDS = Object.keys(CLASS_LIMITS);

const FUNCTION_KINDS = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);
const CLASS_KINDS = new Set([SyntaxKind.ClassDeclaration, SyntaxKind.ClassExpression]);
const DECISION_KINDS = new Set([
  SyntaxKind.IfStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.CaseClause,
  SyntaxKind.CatchClause,
  SyntaxKind.ConditionalExpression,
]);
const NESTING_KINDS = new Set([
  SyntaxKind.IfStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.SwitchStatement,
  SyntaxKind.TryStatement,
]);
const LOGICAL_OPERATORS = new Set(['&&', '||', '??', '&&=', '||=', '??=']);

const HELP = `Usage: node scripts/complexity.mjs [--root <dir>] [--baseline <file>]
                              [--metrics-baseline <file>]
                              [--print-metrics-baseline]

Checks source and test files against the hard limits:
  src/**/*.ts   ${LIMITS[0].limit} lines
  tests/**/*.ts ${LIMITS[1].limit} lines

Checks functions and classes parsed from TypeScript ASTs:
  functions/methods: ${FUNCTION_LIMITS.lines} lines, cyclomatic ${FUNCTION_LIMITS.cyclomatic},
                     nesting ${FUNCTION_LIMITS.nesting}, ${FUNCTION_LIMITS.parameters} parameters
  classes:           body ${CLASS_LIMITS.bodyLines} lines, ${CLASS_LIMITS.publicMethods} public methods,
                     ${CLASS_LIMITS.constructorDependencies} constructor dependencies

Files or declarations already over a limit must be listed in the matching
baseline with their exact values. Baseline entries may only shrink.
--print-metrics-baseline prints the current metric baseline as JSON instead of
checking; it never writes a file. Exit code 0 means the gate passed.
`;

function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    baseline: DEFAULT_BASELINE,
    metricsBaseline: undefined,
    printMetricsBaseline: false,
    help: false,
  };

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
    } else if (arg === '--metrics-baseline') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error('--metrics-baseline needs a file');
      }
      options.metricsBaseline = resolve(value);
      index += 1;
    } else if (arg === '--print-metrics-baseline') {
      options.printMetricsBaseline = true;
    } else {
      throw new Error(`unknown argument '${arg}'`);
    }
  }

  if (options.metricsBaseline === undefined) {
    options.metricsBaseline = join(options.root, 'scripts', METRICS_BASELINE_NAME);
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

function metricShapeForKey(key) {
  if (key.includes('::class ')) {
    return CLASS_FIELDS;
  }
  if (/::(function|arrow|method|constructor|getter|setter) /.test(key)) {
    return FUNCTION_FIELDS;
  }
  return undefined;
}

function loadMetricsBaseline(file) {
  if (!existsSync(file)) {
    return {};
  }

  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read metrics baseline ${file}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`metrics baseline ${file} is not valid JSON: ${error.message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`metrics baseline ${file} must be an object`);
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(`metrics baseline ${file} must declare schemaVersion 1`);
  }

  const metrics = parsed.metrics;
  if (metrics === null || typeof metrics !== 'object' || Array.isArray(metrics)) {
    throw new Error(`metrics baseline ${file} must contain a 'metrics' object`);
  }

  for (const [key, entry] of Object.entries(metrics)) {
    const shape = metricShapeForKey(key);
    if (shape === undefined) {
      throw new Error(
        `metrics baseline ${file}: '${key}' must name a function/class declaration`,
      );
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`metrics baseline ${file}: '${key}' must be an object`);
    }
    for (const field of shape) {
      const value = entry[field];
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(
          `metrics baseline ${file}: '${key}.${field}' must be a non-negative integer`,
        );
      }
    }
    for (const field of Object.keys(entry)) {
      if (!shape.includes(field)) {
        throw new Error(
          `metrics baseline ${file}: '${key}' has unknown field '${field}'`,
        );
      }
    }
  }

  return metrics;
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

  return { checked: files.length, baselined: baselined.size, failures, files };
}

function isFunctionLike(node) {
  return FUNCTION_KINDS.has(node.kind);
}

function isClassLike(node) {
  return CLASS_KINDS.has(node.kind);
}

function functionKind(node) {
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
      return 'function';
    case SyntaxKind.ArrowFunction:
      return 'arrow';
    case SyntaxKind.MethodDeclaration:
      return 'method';
    case SyntaxKind.Constructor:
      return 'constructor';
    case SyntaxKind.GetAccessor:
      return 'getter';
    case SyntaxKind.SetAccessor:
      return 'setter';
    default:
      /* c8 ignore next: callers only pass FUNCTION_KINDS */
      return 'function';
  }
}

function declarationName(node) {
  if (node === undefined || node.name === undefined) {
    return undefined;
  }
  if (node.name.kind === SyntaxKind.Identifier) {
    return node.name.text;
  }
  if (node.name.kind === SyntaxKind.StringLiteral) {
    return node.name.text;
  }
  return undefined;
}

function functionName(node, classContext, lineOf, sourceFile) {
  if (node.kind === SyntaxKind.Constructor) {
    return classContext === undefined ? '<anonymous>' : classContext;
  }

  const direct = declarationName(node);
  if (direct !== undefined) {
    if (
      classContext !== undefined &&
      (node.kind === SyntaxKind.MethodDeclaration ||
        node.kind === SyntaxKind.GetAccessor ||
        node.kind === SyntaxKind.SetAccessor)
    ) {
      return `${classContext}.${direct}`;
    }
    return direct;
  }

  const parentName = declarationName(node.parent);
  if (parentName !== undefined) {
    return classContext === undefined ? parentName : `${classContext}.${parentName}`;
  }

  const anonymous = `<anonymous@${lineOf(node.getStart(sourceFile))}>`;
  return classContext === undefined ? anonymous : `${classContext}.${anonymous}`;
}

function classDisplayName(node, lineOf, sourceFile) {
  const direct = declarationName(node);
  if (direct !== undefined) {
    return direct;
  }
  const parentName = declarationName(node.parent);
  if (parentName !== undefined) {
    return parentName;
  }
  return `<anonymous@${lineOf(node.getStart(sourceFile))}>`;
}

function uniqueKey(counts, base) {
  const seen = (counts.get(base) ?? 0) + 1;
  counts.set(base, seen);
  return seen === 1 ? base : `${base}#${seen}`;
}

function measureFunction(node, sourceFile, lineOf) {
  const startLine = lineOf(node.getStart(sourceFile));
  const endLine = lineOf(node.end - 1);
  const scan = scanFunctionBody(node, sourceFile);
  return {
    lines: endLine - startLine + 1,
    cyclomatic: scan.cyclomatic,
    nesting: scan.nesting,
    parameters: node.parameters === undefined ? 0 : node.parameters.length,
  };
}

function scanFunctionBody(node, sourceFile) {
  let cyclomatic = 1;
  let nesting = 0;

  const walk = (current, depth) => {
    if (current !== node && (isFunctionLike(current) || isClassLike(current))) {
      return;
    }

    let nextDepth = depth;
    if (NESTING_KINDS.has(current.kind)) {
      nextDepth = depth + 1;
      if (nextDepth > nesting) {
        nesting = nextDepth;
      }
    }

    if (DECISION_KINDS.has(current.kind)) {
      cyclomatic += 1;
    } else if (current.kind === SyntaxKind.BinaryExpression) {
      const operator = current.operatorToken.getText(sourceFile);
      if (LOGICAL_OPERATORS.has(operator)) {
        cyclomatic += 1;
      }
    }

    current.forEachChild((child) => walk(child, nextDepth));
  };

  if (node.body !== undefined) {
    walk(node.body, 0);
  }

  return { cyclomatic, nesting };
}

function isPublicMethod(member) {
  if (
    member.kind !== SyntaxKind.MethodDeclaration &&
    member.kind !== SyntaxKind.GetAccessor &&
    member.kind !== SyntaxKind.SetAccessor
  ) {
    return false;
  }
  if (member.name === undefined || member.name.kind === SyntaxKind.PrivateIdentifier) {
    return false;
  }
  const modifiers = member.modifiers === undefined ? [] : member.modifiers;
  return !modifiers.some(
    (modifier) =>
      modifier.kind === SyntaxKind.PrivateKeyword ||
      modifier.kind === SyntaxKind.ProtectedKeyword,
  );
}

function measureClass(node, sourceFile, lineOf) {
  const openBrace =
    sourceFile.text[node.members.pos - 1] === '{' ? node.members.pos - 1 : node.members.pos;
  const startLine = lineOf(openBrace);
  const endLine = lineOf(node.end - 1);

  let publicMethods = 0;
  let constructorDependencies = 0;
  for (const member of node.members) {
    if (isPublicMethod(member)) {
      publicMethods += 1;
    }
    if (member.kind === SyntaxKind.Constructor) {
      const parameters = member.parameters === undefined ? 0 : member.parameters.length;
      if (parameters > constructorDependencies) {
        constructorDependencies = parameters;
      }
    }
  }

  return {
    bodyLines: endLine - startLine + 1,
    publicMethods,
    constructorDependencies,
  };
}

function collectFromSourceFile(file, sourceFile, output) {
  const lineOf = (position) => sourceFile.getLineAndCharacterOfPosition(position).line + 1;

  const visit = (node, classContext) => {
    if (isClassLike(node)) {
      const name = classDisplayName(node, lineOf, sourceFile);
      const qualified = classContext === undefined ? name : `${classContext}.${name}`;
      output.classes.push({
        key: uniqueKey(output.keyCounts, `${file}::class ${qualified}`),
        type: 'class',
        name: qualified,
        metrics: measureClass(node, sourceFile, lineOf),
      });
      node.forEachChild((child) => visit(child, qualified));
      return;
    }

    if (isFunctionLike(node)) {
      if (node.body !== undefined) {
        const kind = functionKind(node);
        const name = functionName(node, classContext, lineOf, sourceFile);
        output.functions.push({
          key: uniqueKey(output.keyCounts, `${file}::${kind} ${name}`),
          type: 'function',
          name: kind === 'function' ? name : `${kind} ${name}`,
          metrics: measureFunction(node, sourceFile, lineOf),
        });
      }
      node.forEachChild((child) => visit(child, undefined));
      return;
    }

    node.forEachChild((child) => visit(child, classContext));
  };

  sourceFile.forEachChild((node) => visit(node, undefined));
}

function scanMetrics(root, files) {
  const absoluteFiles = files.map((file) => resolve(root, ...file.split('/')));
  let api;
  let snapshot;

  try {
    api = new API({ cwd: root });
    snapshot = api.updateSnapshot({ openFiles: absoluteFiles });

    const output = {
      functions: [],
      classes: [],
      keyCounts: new Map(),
      files: files.length,
    };

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const absolute = absoluteFiles[index];
      const project = snapshot.getDefaultProjectForFile(absolute);
      if (project === undefined) {
        throw new Error(`cannot load a TypeScript project for ${file}`);
      }
      const sourceFile = project.program.getSourceFile(absolute);
      if (sourceFile === undefined) {
        throw new Error(`cannot load TypeScript source file ${file}`);
      }
      collectFromSourceFile(file, sourceFile, output);
    }

    return output;
  } finally {
    try {
      if (snapshot !== undefined) {
        snapshot.dispose();
      }
    } finally {
      if (api !== undefined) {
        api.close();
      }
    }
  }
}

function exceededFields(entry) {
  const limits = entry.type === 'class' ? CLASS_LIMITS : FUNCTION_LIMITS;
  const fields = [];
  for (const [field, limit] of Object.entries(limits)) {
    if (entry.metrics[field] > limit) {
      fields.push(field);
    }
  }
  return fields;
}

function formatFunctionMetrics(metrics) {
  const parts = [];
  if (metrics.lines > FUNCTION_LIMITS.lines) {
    parts.push(`lines ${metrics.lines} > ${FUNCTION_LIMITS.lines}`);
  }
  if (metrics.cyclomatic > FUNCTION_LIMITS.cyclomatic) {
    parts.push(`cyclomatic ${metrics.cyclomatic} > ${FUNCTION_LIMITS.cyclomatic}`);
  }
  if (metrics.nesting > FUNCTION_LIMITS.nesting) {
    parts.push(`nesting ${metrics.nesting} > ${FUNCTION_LIMITS.nesting}`);
  }
  if (metrics.parameters > FUNCTION_LIMITS.parameters) {
    parts.push(`parameters ${metrics.parameters} > ${FUNCTION_LIMITS.parameters}`);
  }
  return parts.join(', ');
}

function formatClassMetrics(metrics) {
  const parts = [];
  if (metrics.bodyLines > CLASS_LIMITS.bodyLines) {
    parts.push(`body ${metrics.bodyLines} > ${CLASS_LIMITS.bodyLines} lines`);
  }
  if (metrics.publicMethods > CLASS_LIMITS.publicMethods) {
    parts.push(`public methods ${metrics.publicMethods} > ${CLASS_LIMITS.publicMethods}`);
  }
  if (metrics.constructorDependencies > CLASS_LIMITS.constructorDependencies) {
    parts.push(
      `constructor dependencies ${metrics.constructorDependencies} > ` +
        `${CLASS_LIMITS.constructorDependencies}`,
    );
  }
  return parts.join(', ');
}

function formatMetrics(entry) {
  return entry.type === 'class'
    ? formatClassMetrics(entry.metrics)
    : formatFunctionMetrics(entry.metrics);
}

function metricFields(entry) {
  return entry.type === 'class' ? CLASS_FIELDS : FUNCTION_FIELDS;
}

function checkMetricsBaseline(current, baseline) {
  const entries = [...current.functions, ...current.classes].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );

  const failures = [];
  const baselined = new Set();

  for (const entry of entries) {
    const exceeded = exceededFields(entry);
    const allowed = baseline[entry.key];

    if (allowed === undefined) {
      if (exceeded.length > 0) {
        failures.push(
          `${entry.key}: ${formatMetrics(entry)} (no metrics baseline entry)`,
        );
      }
      continue;
    }

    baselined.add(entry.key);

    if (exceeded.length === 0) {
      failures.push(
        `${entry.key}: no longer exceeds the ${entry.type} hard limits; ` +
          `remove the metrics baseline entry`,
      );
      continue;
    }

    for (const field of metricFields(entry)) {
      const recorded = allowed[field];
      const actual = entry.metrics[field];
      if (actual > recorded) {
        failures.push(
          `${entry.key}: ${field} grew from the baselined ${recorded} to ${actual}; ` +
            `a baselined ${entry.type} may not grow`,
        );
      } else if (actual < recorded) {
        failures.push(
          `${entry.key}: metrics baseline is stale for ${field}: recorded ${recorded}, ` +
            `actual ${actual}; lower the entry to ${actual} (baseline may only shrink)`,
        );
      }
    }
  }

  for (const key of Object.keys(baseline).sort()) {
    if (!baselined.has(key)) {
      failures.push(
        `${key}: metrics baseline entry does not match a scanned function or class; remove it`,
      );
    }
  }

  return { checked: entries.length, baselined: baselined.size, failures };
}

function buildMetricsBaseline(current) {
  const entries = [...current.functions, ...current.classes].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
  const metrics = {};
  for (const entry of entries) {
    if (exceededFields(entry).length > 0) {
      metrics[entry.key] =
        entry.type === 'class'
          ? {
              bodyLines: entry.metrics.bodyLines,
              publicMethods: entry.metrics.publicMethods,
              constructorDependencies: entry.metrics.constructorDependencies,
            }
          : {
              lines: entry.metrics.lines,
              cyclomatic: entry.metrics.cyclomatic,
              nesting: entry.metrics.nesting,
              parameters: entry.metrics.parameters,
            };
    }
  }
  return { schemaVersion: 1, metrics };
}

function checkMetricsRepository(root, baselineFile, files) {
  const baseline = loadMetricsBaseline(baselineFile);
  const current = scanMetrics(root, files);
  return checkMetricsBaseline(current, baseline);
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

  if (options.printMetricsBaseline) {
    let current;
    try {
      const files = LIMITS.flatMap(({ dir }) => listTypeScriptFiles(options.root, dir)).sort();
      current = scanMetrics(options.root, files);
    } catch (error) {
      console.error(`complexity: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(buildMetricsBaseline(current), null, 2)}\n`);
    return;
  }

  let fileResult;
  let metricsResult;
  try {
    fileResult = checkRepository(options.root, options.baseline);
    metricsResult = checkMetricsRepository(
      options.root,
      options.metricsBaseline,
      fileResult.files,
    );
  } catch (error) {
    console.error(`complexity: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const failures = [...fileResult.failures, ...metricsResult.failures];
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`complexity: ${failure}`);
    }
    console.error(
      `complexity: failed with ${failures.length} violation(s) ` +
        `(${fileResult.checked} files scanned; baseline ${toPosixPath(relative(process.cwd(), options.baseline))}; ` +
        `metrics baseline ${toPosixPath(relative(process.cwd(), options.metricsBaseline))})`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `complexity: ok (${fileResult.checked} files scanned, ` +
      `${fileResult.baselined} baselined at recorded bounds; ` +
      `${metricsResult.checked} functions/classes checked, ` +
      `${metricsResult.baselined} metrics baselined; ` +
      `limits src ${LIMITS[0].limit}, tests ${LIMITS[1].limit}, ` +
      `functions ${FUNCTION_LIMITS.lines} lines/${FUNCTION_LIMITS.cyclomatic} cyclomatic/` +
      `${FUNCTION_LIMITS.nesting} nesting/${FUNCTION_LIMITS.parameters} parameters, ` +
      `classes ${CLASS_LIMITS.bodyLines} body lines/${CLASS_LIMITS.publicMethods} public methods/` +
      `${CLASS_LIMITS.constructorDependencies} constructor dependencies)`,
  );
}

main(process.argv.slice(2));
