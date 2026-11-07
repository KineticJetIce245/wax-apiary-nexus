import type { CompositionDefinition } from '../runtime/types.js';
import { sameProjectPath } from '../storage/conversation-store.js';

/**
 * How one forager node obtains its native conversation. `session` reuses an
 * existing WAX session; `fresh` asks the session layer to create one. B-core's
 * first version never shares a session between two foragers.
 */
export type ForagerBinding =
  | { readonly kind: 'session'; readonly sessionId: string }
  | {
      readonly kind: 'fresh';
      readonly model?: string;
      readonly reasoning?: string;
    };

export type GraphBindings = Readonly<Record<string, ForagerBinding>>;

export type BindingIssueCode =
  | 'missing-binding'
  | 'unknown-binding'
  | 'not-forager'
  | 'invalid-binding'
  | 'empty-session'
  | 'unknown-session'
  | 'wrong-harness'
  | 'wrong-project'
  | 'busy-session'
  | 'duplicate-session'
  | 'invalid-fresh';

export interface BindingIssue {
  readonly code: BindingIssueCode;
  readonly message: string;
  readonly nodeId?: string;
  readonly sessionId?: string;
}

/** What the binding layer reads from a session record, and nothing more. */
export interface BindingRecord {
  readonly sessionId: string;
  readonly harness?: string;
  readonly projectDirectory?: string;
}

/**
 * Read-only view of the session layer used by binding validation. Validation
 * must never create, resume, or close a session, so the lookup deliberately
 * cannot do any of those things.
 */
export interface BindingLookup {
  get(sessionId: string): BindingRecord | undefined;
  isBusy(sessionId: string): boolean;
}

/**
 * The harness/project a composition is being bound for. Each field is optional
 * and independent: an omitted field is not checked.
 */
export interface BindingContext {
  readonly harness?: string;
  readonly projectDirectory?: string;
}

export interface BindingValidation {
  readonly ok: boolean;
  readonly issues: readonly BindingIssue[];
}

/**
 * Validate that every forager in the composition has a usable binding. This
 * only checks the binding layer; graph structure is already validated by
 * `parseComposition`.
 *
 * Bindings may originate from untrusted JSON, so validation is total: a
 * malformed binding map or value yields `invalid-binding` instead of throwing.
 * A malformed top-level map is rejected before any lookup is consulted.
 *
 * Issues are deterministic: definition node order first, then binding keys that
 * name no definition node, in binding key insertion order. For one forager the
 * shape checks run first, then empty -> duplicate -> unknown -> wrong-harness ->
 * wrong-project -> busy; a fresh binding is checked for non-empty
 * model/reasoning metadata. Harness/project checks apply only to session
 * bindings (a fresh binding has no session record yet) and only when the
 * corresponding `context` field is present.
 */
export function validateBindings(
  definition: CompositionDefinition,
  bindings: GraphBindings,
  lookup: BindingLookup,
  context?: BindingContext,
): BindingValidation {
  const rawBindings: unknown = bindings;
  if (!isRecord(rawBindings)) {
    return {
      ok: false,
      issues: [
        {
          code: 'invalid-binding',
          message: 'bindings must be an object keyed by node id',
        },
      ],
    };
  }

  const issues: BindingIssue[] = [];
  const boundSessions = new Set<string>();

  for (const node of definition.nodes.values()) {
    if (!Object.hasOwn(rawBindings, node.id)) {
      if (node.kind === 'forager') {
        issues.push({
          code: 'missing-binding',
          message: `forager '${node.id}' has no session binding`,
          nodeId: node.id,
        });
      }
      continue;
    }

    const binding = rawBindings[node.id];
    if (!isRecord(binding)) {
      issues.push({
        code: 'invalid-binding',
        message: `node '${node.id}' binding must be an object`,
        nodeId: node.id,
      });
      continue;
    }

    const kind = binding['kind'];
    if (kind !== 'session' && kind !== 'fresh') {
      issues.push({
        code: 'invalid-binding',
        message: `node '${node.id}' binding kind must be 'session' or 'fresh'`,
        nodeId: node.id,
      });
      continue;
    }

    const sessionId = binding['sessionId'];
    if (kind === 'session' && typeof sessionId !== 'string') {
      issues.push({
        code: 'invalid-binding',
        message: `node '${node.id}' session binding requires a string sessionId`,
        nodeId: node.id,
      });
      continue;
    }

    if (node.kind !== 'forager') {
      issues.push({
        code: 'not-forager',
        message: `${node.kind} node '${node.id}' cannot be bound to a forager session`,
        nodeId: node.id,
        ...(kind === 'session' ? { sessionId: binding['sessionId'] as string } : {}),
      });
      continue;
    }

    if (kind === 'fresh') {
      validateFreshMetadata(node.id, binding, issues);
    } else {
      // The shape check above guarantees a string for a session binding.
      validateSessionBinding(
        node.id,
        binding['sessionId'] as string,
        lookup,
        boundSessions,
        issues,
        context,
      );
    }
  }

  for (const nodeId of Object.keys(rawBindings)) {
    if (!definition.nodes.has(nodeId)) {
      issues.push({
        code: 'unknown-binding',
        message: `binding names unknown node '${nodeId}'`,
        nodeId,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSessionBinding(
  nodeId: string,
  sessionId: string,
  lookup: BindingLookup,
  boundSessions: Set<string>,
  issues: BindingIssue[],
  context: BindingContext | undefined,
): void {
  if (sessionId.trim() === '') {
    issues.push({
      code: 'empty-session',
      message: `forager '${nodeId}' binds an empty session id`,
      nodeId,
      sessionId,
    });
    return;
  }

  // B-core v1 forbids two foragers sharing one session: the same native
  // conversation cannot safely run two executions at once.
  if (boundSessions.has(sessionId)) {
    issues.push({
      code: 'duplicate-session',
      message: `session '${sessionId}' is bound to more than one forager`,
      nodeId,
      sessionId,
    });
    return;
  }
  boundSessions.add(sessionId);

  const record = lookup.get(sessionId);
  if (record === undefined) {
    issues.push({
      code: 'unknown-session',
      message: `session '${sessionId}' bound by forager '${nodeId}' does not exist`,
      nodeId,
      sessionId,
    });
    return;
  }

  const expectedHarness = context?.harness;
  if (expectedHarness !== undefined && record.harness !== expectedHarness) {
    issues.push({
      code: 'wrong-harness',
      message: `session '${sessionId}' bound by forager '${nodeId}' belongs to harness '${record.harness ?? '<unknown>'}', expected '${expectedHarness}'`,
      nodeId,
      sessionId,
    });
  }

  const expectedProject = context?.projectDirectory;
  if (
    expectedProject !== undefined &&
    (record.projectDirectory === undefined ||
      !sameProjectPath(record.projectDirectory, expectedProject))
  ) {
    issues.push({
      code: 'wrong-project',
      message: `session '${sessionId}' bound by forager '${nodeId}' does not belong to project directory '${expectedProject}'`,
      nodeId,
      sessionId,
    });
  }

  if (lookup.isBusy(sessionId)) {
    issues.push({
      code: 'busy-session',
      message: `session '${sessionId}' bound by forager '${nodeId}' is busy`,
      nodeId,
      sessionId,
    });
  }
}

function validateFreshMetadata(
  nodeId: string,
  binding: Record<string, unknown>,
  issues: BindingIssue[],
): void {
  for (const field of ['model', 'reasoning'] as const) {
    const value = binding[field];
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      issues.push({
        code: 'invalid-fresh',
        message: `forager '${nodeId}' fresh binding has an empty ${field}`,
        nodeId,
      });
    }
  }
}
