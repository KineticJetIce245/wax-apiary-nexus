import {
  CliUsageError,
  apiaryForProject,
  loadCompositionFile,
  messageOf,
} from './cli-shared.js';
import {
  createAnswerId,
  writeAnswerRecord,
  type AnswerRecord,
} from './answer-inbox.js';
import { HoneyStore } from './honey.js';
import type {
  CompositionDefinition,
  HoverSpec,
  NodeId,
  PersistedField,
  UserNode,
  Value,
} from './runtime/index.js';
import { parseUserAnswer } from './user-answer.js';

const DEFAULT_STATE_DIR = '~/.wax';

const VALUE_FLAGS = new Set([
  '--project',
  '--node',
  '--token',
  '--state-dir',
  '--apiary',
  '--text',
  '--choice',
  '--image',
  '--file',
]);
const BOOLEAN_FLAGS = new Set(['--yes', '--no']);

const ANSWER_USAGE =
  'usage: wax answer <composition.json> --project <dir> --node <user-node> ' +
  '[--token <hover-token>] <--text <text>|--choice <label>|--yes|--no|--image <path>|--file <path>> ' +
  '[--state-dir <dir>] [--apiary <id>]';

/** Exactly one answer source flag; its kind must match the user modality. */
export type AnswerSource =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'choice'; readonly choice: string }
  | { readonly kind: 'yes' }
  | { readonly kind: 'no' }
  | { readonly kind: 'image'; readonly path: string }
  | { readonly kind: 'file'; readonly path: string };

export interface AnswerCommand {
  readonly compositionPath: string;
  readonly projectDirectory: string;
  readonly nodeId: NodeId;
  readonly token?: string;
  readonly stateDir: string;
  readonly apiary?: string;
  readonly source: AnswerSource;
}

export interface AnswerCliDependencies {
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

interface OpenHover {
  readonly nodeId: NodeId;
  readonly hover: HoverSpec;
}

export function parseAnswerArgs(argv: readonly string[]): AnswerCommand {
  const [command, ...rest] = argv;
  if (command !== 'answer') {
    throw new CliUsageError(ANSWER_USAGE);
  }

  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const booleans = new Set<string>();

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) {
      continue;
    }
    if (BOOLEAN_FLAGS.has(token)) {
      if (booleans.has(token)) {
        throw new CliUsageError(`option '${token}' was given more than once`);
      }
      booleans.add(token);
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
    throw new CliUsageError('expected exactly one composition file after "wax answer"');
  }

  const compositionPath = positionals[0] as string;
  const projectDirectory = flags.get('--project');
  if (projectDirectory === undefined) {
    throw new CliUsageError('missing required option --project <dir>');
  }
  const nodeId = flags.get('--node');
  if (nodeId === undefined) {
    throw new CliUsageError('missing required option --node <user-node>');
  }

  const sources: AnswerSource[] = [];
  const text = flags.get('--text');
  if (text !== undefined) {
    sources.push({ kind: 'text', text });
  }
  const choice = flags.get('--choice');
  if (choice !== undefined) {
    sources.push({ kind: 'choice', choice });
  }
  const image = flags.get('--image');
  if (image !== undefined) {
    sources.push({ kind: 'image', path: image });
  }
  const file = flags.get('--file');
  if (file !== undefined) {
    sources.push({ kind: 'file', path: file });
  }
  if (booleans.has('--yes')) {
    sources.push({ kind: 'yes' });
  }
  if (booleans.has('--no')) {
    sources.push({ kind: 'no' });
  }
  if (sources.length !== 1) {
    throw new CliUsageError(
      'pass exactly one answer source: --text, --choice, --yes, --no, --image or --file',
    );
  }

  const apiary = flags.get('--apiary');
  const token = flags.get('--token');

  return {
    compositionPath,
    projectDirectory,
    nodeId,
    ...(token === undefined ? {} : { token }),
    stateDir: flags.get('--state-dir') ?? DEFAULT_STATE_DIR,
    ...(apiary === undefined ? {} : { apiary }),
    source: sources[0] as AnswerSource,
  };
}

function openUserHovers(
  definition: CompositionDefinition,
  field: PersistedField,
): OpenHover[] {
  const hovers: OpenHover[] = [];
  for (const [id, node] of definition.nodes) {
    if (node.kind !== 'user') {
      continue;
    }
    const hover = field.nodes[id]?.hover;
    if (hover !== undefined && hover.kind === 'user') {
      hovers.push({ nodeId: id, hover });
    }
  }
  return hovers;
}

function chooseHover(
  hovers: readonly OpenHover[],
  nodeId: NodeId,
  token: string | undefined,
): OpenHover {
  if (token === undefined) {
    if (hovers.length === 0) {
      throw new CliUsageError('no open user hover; there is nothing to answer');
    }
    if (hovers.length > 1) {
      throw new CliUsageError(
        `multiple open user hovers (${hovers.map((entry) => entry.nodeId).join(', ')}); ` +
          'pass --token <hover-token>',
      );
    }
    const hover = hovers[0] as OpenHover;
    if (hover.nodeId !== nodeId) {
      throw new CliUsageError(
        `the open user hover belongs to node '${hover.nodeId}', not '${nodeId}'`,
      );
    }
    return hover;
  }

  const matching = hovers.filter((entry) => entry.hover.token === token);
  if (matching.length === 0) {
    throw new CliUsageError(`no open user hover with token '${token}'`);
  }
  if (matching.length > 1) {
    throw new CliUsageError(`multiple open user hovers share the token '${token}'`);
  }
  const hover = matching[0] as OpenHover;
  if (hover.nodeId !== nodeId) {
    throw new CliUsageError(
      `the open user hover for token '${token}' belongs to node '${hover.nodeId}', not '${nodeId}'`,
    );
  }
  return hover;
}

function answerForSource(node: UserNode, source: AnswerSource): Value {
  const modality = node.config.modality;
  if (source.kind === 'text') {
    if (modality === 'text' || modality === 'message') {
      return parseUserAnswer(node, source.text);
    }
    throw new CliUsageError(
      `user node '${node.id}' has modality '${modality}'; --text does not match it`,
    );
  }
  if (source.kind === 'choice') {
    if (modality === 'choice') {
      return parseUserAnswer(node, source.choice);
    }
    throw new CliUsageError(
      `user node '${node.id}' has modality '${modality}'; --choice does not match it`,
    );
  }
  if (source.kind === 'yes' || source.kind === 'no') {
    if (modality === 'yes-no') {
      return parseUserAnswer(node, source.kind);
    }
    throw new CliUsageError(
      `user node '${node.id}' has modality '${modality}'; --${source.kind} does not match it`,
    );
  }
  if (source.kind === 'image' || source.kind === 'file') {
    if (modality === source.kind) {
      return parseUserAnswer(node, source.path);
    }
    throw new CliUsageError(
      `user node '${node.id}' has modality '${modality}'; --${source.kind} does not match it`,
    );
  }
  throw new CliUsageError(`user node '${node.id}' has an unsupported answer source`);
}

/**
 * Queues one answer for a running daemon.
 *
 * The CLI is not a field writer. It only reads the current Honey field to find
 * the open hover and creates one inbox file through a same-directory temp file
 * plus rename. The daemon remains the only process that calls `answerHover`.
 */
export async function runAnswerCli(
  argv: readonly string[],
  deps: AnswerCliDependencies = {},
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  try {
    const command = parseAnswerArgs(argv);
    const definition = loadCompositionFile(command.compositionPath);
    const node = definition.nodes.get(command.nodeId);
    if (node === undefined) {
      throw new CliUsageError(`unknown node '${command.nodeId}'`);
    }
    if (node.kind !== 'user') {
      throw new CliUsageError(
        `node '${command.nodeId}' is not a user node, got '${node.kind}'`,
      );
    }

    const apiary = command.apiary ?? apiaryForProject(command.projectDirectory);
    const store = HoneyStore.forComposition(command.stateDir, apiary, definition.id);
    const field = store.load();
    if (field === undefined) {
      throw new CliUsageError(
        `no Honey field at ${store.paths.field}; start the daemon before answering`,
      );
    }
    if (field.compositionId !== definition.id) {
      throw new CliUsageError(
        `Honey field belongs to composition '${field.compositionId}', not '${definition.id}'`,
      );
    }
    if (field.graphRevision !== definition.graphRevision) {
      throw new CliUsageError(
        `Honey field was written for graph revision '${field.graphRevision}', ` +
          `current is '${definition.graphRevision}'; restart the daemon`,
      );
    }

    const hover = chooseHover(openUserHovers(definition, field), node.id, command.token);
    const value = answerForSource(node, command.source);
    const record: AnswerRecord = {
      answerId: createAnswerId(),
      compositionId: definition.id,
      nodeId: node.id,
      hoverToken: hover.hover.token,
      value,
      at: new Date().toISOString(),
    };
    writeAnswerRecord(store.paths.answers, record);
    out(`answer queued ${record.answerId} node=${node.id}`);
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      err(error.message);
      return 2;
    }
    err(`error: ${messageOf(error)}`);
    return 1;
  }
}
