import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** One persisted conversation ↔ native session mapping. */
export interface ConversationRecord {
  readonly conversationId: string;
  readonly harness: string;
  readonly nativeId: string;
  readonly projectId: string;
  readonly projectDirectory: string;
  readonly updatedAt: string;
}

export function defaultConversationStorePath(): string {
  return join(homedir(), '.unified-workspace', 'conversations.json');
}

function isRecord(value: unknown): value is ConversationRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.conversationId === 'string' &&
    typeof record.harness === 'string' &&
    typeof record.nativeId === 'string' &&
    typeof record.projectId === 'string' &&
    typeof record.projectDirectory === 'string' &&
    typeof record.updatedAt === 'string'
  );
}

/**
 * Small JSON store for conversation mappings. Writes go through a sibling
 * temp file plus rename so a crash cannot leave a half-written file; the file
 * is private (0600 on POSIX).
 */
export class ConversationStore {
  constructor(readonly filePath: string = defaultConversationStorePath()) {}

  load(): ConversationRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`Conversation store must contain an array: ${this.filePath}`);
    }
    return parsed.filter(isRecord);
  }

  save(records: readonly ConversationRecord[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }

  upsert(record: ConversationRecord): void {
    const records = this.load().filter(
      (entry) => entry.conversationId !== record.conversationId,
    );
    records.push(record);
    this.save(records);
  }

  find(conversationId: string): ConversationRecord | undefined {
    return this.load().find((entry) => entry.conversationId === conversationId);
  }

  latestForProject(projectDirectory: string): ConversationRecord | undefined {
    const target = resolve(projectDirectory);
    const matches = this.load().filter(
      (entry) => resolve(entry.projectDirectory) === target,
    );
    matches.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return matches[0];
  }
}
