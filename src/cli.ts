import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import { CodexAppServerAdapter } from './adapters/codex/adapter.js';
import type { ApprovalDecisionKind, ApprovalRequest, HarnessAdapter } from './adapters/harness.js';
import { createCodexConnection, type HarnessKind } from './connection.js';
import { WorkspaceForagerExecutor, type ApprovalHandler } from './forager.js';
import { createKernel } from './kernel.js';
import {
  CompositionValidationError,
  createMemoryLog,
  parseComposition,
  PheromoneRuntime,
  type CompositionDefinition,
  type PheromoneFieldSnapshot,
  type RuntimeLogEntry,
} from './runtime/index.js';
import { Workspace } from './workspace.js';

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export interface RunCommand {
  readonly compositionPath: string;
  readonly projectDirectory: string;
  readonly harness: HarnessKind;
  readonly trigger: string;
  readonly input: string;
  readonly dshRoot?: string;
}

export interface CliDependencies {
  /** Test seam: replace the native adapter factory. */
  readonly createAdapter?: (harness: HarnessKind) => Promise<HarnessAdapter>;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly askApproval?: ApprovalHandler;
}

const VALUE_FLAGS = new Set(['--project', '--harness', '--trigger', '--input', '--dsh-root']);

export function parseRunArgs(argv: readonly string[]): RunCommand {
  const [command, ...rest] = argv;
  if (command !== 'run') {
    throw new CliUsageError('usage: wax run <composition.json> --project <dir> --harness <codex|dsh> --trigger <node> [--input <text>]');
  }

  const positionals: string[] = [];
  const flags = new Map<string, string>();

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) {
      continue;
    }
    if (token.startsWith('--')) {
      if (!VALUE_FLAGS.has(token)) {
        throw new CliUsageError(`unknown option '${token}'`);
      }
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new CliUsageError(`option '${token}' needs a value`);
      }
      if (flags.has(token)) {
        throw new CliUsageError(`option '${token}' was given more than once`);
      }
      flags.set(token, value);
      index += 1;
      continue;
    }
    positionals.push(token);
  }

  if (positionals.length !== 1) {
    throw new CliUsageError('expected exactly one composition file after "wax run"');
  }

  const compositionPath = positionals[0] as string;
  const projectDirectory = flags.get('--project');
  if (projectDirectory === undefined) {
    throw new CliUsageError('missing required option --project <dir>');
  }

  const harness = flags.get('--harness');
  if (harness !== 'codex' && harness !== 'dsh') {
    throw new CliUsageError(`--harness must be 'codex' or 'dsh', got '${harness ?? ''}'`);
  }

  const trigger = flags.get('--trigger');
  if (trigger === undefined) {
    throw new CliUsageError('missing required option --trigger <node>');
  }

  const dshRoot = flags.get('--dsh-root');

  return {
    compositionPath,
    projectDirectory,
    harness,
    trigger,
    input: flags.get('--input') ?? '',
    ...(dshRoot === undefined ? {} : { dshRoot }),
  };
}

function loadComposition(path: string): CompositionDefinition {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new CliUsageError(`cannot read composition file ${path}: ${messageOf(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliUsageError(`composition file ${path} is not valid JSON: ${messageOf(error)}`);
  }

  try {
    return parseComposition(parsed);
  } catch (error) {
    if (error instanceof CompositionValidationError) {
      throw new CliUsageError(error.message);
    }
    throw error;
  }
}

function validateTrigger(definition: CompositionDefinition, trigger: string): void {
  const node = definition.nodes.get(trigger);
  if (node === undefined) {
    throw new CliUsageError(`unknown trigger node '${trigger}'`);
  }
  if (node.kind !== 'forager') {
    throw new CliUsageError(`trigger target '${trigger}' must be a forager node, got '${node.kind}'`);
  }
}

function fallbackDecision(request: ApprovalRequest): ApprovalDecisionKind {
  const offered = new Set(request.options.map((option) => option.kind));
  return offered.has('reject_once') ? 'reject_once' : 'cancelled';
}

/**
 * Interactive approval for the one-shot CLI. A non-interactive stdin never
 * allows: it falls back to rejecting (or cancelling) so a piped run cannot
 * grant permissions by accident.
 */
async function askApprovalInteractively(request: ApprovalRequest): Promise<ApprovalDecisionKind> {
  if (process.stdin.isTTY !== true) {
    return fallbackDecision(request);
  }

  const offered = request.options.filter(
    (option) => option.kind === 'allow_once' || option.kind === 'reject_once',
  );
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(`approval required: ${request.summary}\n`);
    offered.forEach((option, index) => {
      process.stderr.write(`  ${String(index + 1)}. ${option.label}\n`);
    });
    process.stderr.write(`  ${String(offered.length + 1)}. cancel\n`);
    const answer = (await rl.question(`choose [1-${String(offered.length + 1)}]: `)).trim();
    const index = Number(answer) - 1;
    const chosen = Number.isInteger(index) ? offered[index] : undefined;
    if (chosen?.kind === 'allow_once' || chosen?.kind === 'reject_once') {
      return chosen.kind;
    }
    return 'cancelled';
  } catch {
    return fallbackDecision(request);
  } finally {
    rl.close();
  }
}

async function createDefaultAdapter(harness: HarnessKind): Promise<HarnessAdapter> {
  if (harness === 'dsh') {
    throw new CliUsageError('the dsh bridge is not wired in Stage 2A; run with --harness codex');
  }
  const connection = await createCodexConnection();
  return new CodexAppServerAdapter({ launch: connection.launch });
}

export async function runCli(argv: readonly string[], deps: CliDependencies = {}): Promise<number> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  let command: RunCommand;
  let definition: CompositionDefinition;
  try {
    command = parseRunArgs(argv);
    if (command.harness === 'dsh' && command.dshRoot === undefined) {
      throw new CliUsageError('--harness dsh requires --dsh-root <path>');
    }
    definition = loadComposition(command.compositionPath);
    validateTrigger(definition, command.trigger);
    if (command.harness === 'dsh') {
      throw new CliUsageError('the dsh bridge is not wired in Stage 2A; run with --harness codex');
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      err(error.message);
      return 2;
    }
    throw error;
  }

  const createAdapter = deps.createAdapter ?? createDefaultAdapter;
  let adapter: HarnessAdapter;
  try {
    adapter = await createAdapter(command.harness);
    await adapter.start();
  } catch (error) {
    err(`error: ${messageOf(error)}`);
    return 1;
  }

  const workspace = new Workspace(adapter);
  const log = createMemoryLog();
  let forager: WorkspaceForagerExecutor | undefined;
  let code = 0;

  try {
    const project = createKernel().registerProject(command.projectDirectory);
    const conversation = await workspace.createConversation(project);
    forager = new WorkspaceForagerExecutor({
      workspace,
      conversation,
      onApproval: deps.askApproval ?? askApprovalInteractively,
    });

    const runtime = new PheromoneRuntime(definition, {
      executeForager: forager,
      onLog: log.sink,
    });

    runtime.trigger(command.trigger, { kind: 'text', text: command.input });

    let failure: unknown;
    try {
      await runtime.pump();
    } catch (error) {
      failure = error;
    }

    printSummary(out, definition, runtime.snapshot(), log.entries, forager.lastOutput);

    if (failure !== undefined) {
      err(`error: ${messageOf(failure)}`);
      code = 1;
    }
  } catch (error) {
    err(`error: ${messageOf(error)}`);
    code = 1;
  } finally {
    forager?.dispose();
    await workspace.stop().catch(() => undefined);
  }

  return code;
}

function printSummary(
  out: (line: string) => void,
  definition: CompositionDefinition,
  snapshot: PheromoneFieldSnapshot,
  entries: readonly RuntimeLogEntry[],
  output: { readonly kind: string; readonly text?: string } | undefined,
): void {
  out(`composition  ${definition.id}`);
  out(`revision     ${definition.graphRevision}`);
  out(`rest         ${String(snapshot.rest)}`);

  for (const [id, node] of definition.nodes) {
    const state = snapshot.nodes[id];
    const count = state?.state['count'];
    out(
      `node         ${id} kind=${node.kind} queue=${String(state?.queue.length ?? 0)} ` +
        `pending=${state?.pending === undefined ? 'no' : 'yes'} ` +
        `active=${state?.active === undefined ? 'no' : 'yes'}` +
        (typeof count === 'number' ? ` count=${String(count)}` : ''),
    );
  }

  const events = [...new Set(entries.map((entry) => entry.event))];
  out(`log          ${String(entries.length)} events (${events.join(', ')})`);
  out(`output       ${output?.kind === 'text' ? (output.text ?? '') : ''}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
