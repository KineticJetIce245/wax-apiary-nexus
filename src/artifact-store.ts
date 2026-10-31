import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';

import type { Attachment, AttachmentKind } from './content.js';

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const ARTIFACT_ID = /^[a-f0-9]{64}$/;

const MIME_ALLOWLIST = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'text/plain',
  'application/json',
  'application/pdf',
  'application/octet-stream',
]);

export interface Artifact {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly mimeType: string;
  readonly name: string;
  readonly byteLength: number;
}

export interface ArtifactStoreOptions {
  readonly root?: string;
  readonly maxBytes?: number;
}

export class ArtifactError extends Error {
  constructor(
    message: string,
    readonly code: 'not-a-file' | 'too-large' | 'unsupported-type' | 'unreadable',
  ) {
    super(message);
    this.name = 'ArtifactError';
  }
}

export interface ArtifactAttempt {
  readonly artifact?: Artifact;
  readonly error?: string;
}

/**
 * Copies native attachments into a process-local, content-addressed directory.
 * The browser only ever receives an id, never a source path. Symlinks and
 * non-regular files are rejected; the source is read once into memory under a
 * hard size cap so the hash and bytes describe the same content.
 */
export class ArtifactStore {
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly artifacts = new Map<string, Artifact>();
  private readonly paths = new Map<string, string>();
  private readonly files = new Set<string>();
  private closed = false;

  constructor(options: ArtifactStoreOptions = {}) {
    this.root = options.root ?? mkdtempSync(join(tmpdir(), 'uw-artifacts-'));
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isFinite(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error(`maxBytes must be a positive number: ${String(options.maxBytes)}`);
    }
  }

  get directory(): string {
    return this.root;
  }

  tryRegister(attachment: Attachment): ArtifactAttempt {
    try {
      return { artifact: this.register(attachment) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  register(attachment: Attachment): Artifact {
    this.assertOpen();
    if (!MIME_ALLOWLIST.has(attachment.mimeType)) {
      throw new ArtifactError(`Unsupported content type: ${attachment.mimeType}`, 'unsupported-type');
    }
    if (attachment.kind === 'image' && !attachment.mimeType.startsWith('image/')) {
      throw new ArtifactError('Image attachment must have an image MIME type', 'unsupported-type');
    }
    let stat;
    try {
      stat = lstatSync(attachment.path);
    } catch {
      throw new ArtifactError('Attachment is not a readable file', 'not-a-file');
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new ArtifactError('Attachment must be a regular file (symlinks are rejected)', 'not-a-file');
    }
    if (stat.size > this.maxBytes) {
      throw new ArtifactError(
        `Attachment exceeds the ${String(this.maxBytes)} byte limit`,
        'too-large',
      );
    }

    let bytes: Buffer;
    try {
      bytes = readFileSync(attachment.path);
    } catch {
      throw new ArtifactError('Attachment could not be read', 'unreadable');
    }
    if (bytes.byteLength > this.maxBytes) {
      throw new ArtifactError(
        `Attachment exceeds the ${String(this.maxBytes)} byte limit`,
        'too-large',
      );
    }

    const id = createHash('sha256').update(bytes).digest('hex');
    const existing = this.artifacts.get(id);
    if (existing !== undefined) {
      return { ...existing };
    }

    const extension = safeExtension(attachment.path);
    const target = join(this.root, `${id}${extension}`);
    try {
      writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
      this.files.add(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw new ArtifactError('Attachment could not be stored', 'unreadable');
      }
    }

    const artifact: Artifact = {
      id,
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      name: attachment.name ?? basename(attachment.path),
      byteLength: bytes.byteLength,
    };
    this.artifacts.set(id, artifact);
    this.paths.set(id, target);
    return { ...artifact };
  }

  get(id: string): Artifact | undefined {
    if (!ARTIFACT_ID.test(id)) {
      return undefined;
    }
    const artifact = this.artifacts.get(id);
    return artifact === undefined ? undefined : { ...artifact };
  }

  read(id: string): Buffer | undefined {
    this.assertOpen();
    if (!ARTIFACT_ID.test(id)) {
      return undefined;
    }
    const artifact = this.artifacts.get(id);
    if (artifact === undefined) {
      return undefined;
    }
    const artifactPath = this.paths.get(id);
    if (artifactPath === undefined) {
      return undefined;
    }
    try {
      return readFileSync(artifactPath);
    } catch {
      return undefined;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const file of this.files) {
      try {
        unlinkSync(file);
      } catch {
        // Best effort; the OS temp directory remains the fallback cleanup.
      }
    }
    this.files.clear();
    this.artifacts.clear();
    this.paths.clear();
    try {
      rmdirSync(this.root);
    } catch {
      // Non-empty or already gone; do not recursively delete.
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('ArtifactStore is closed');
    }
  }
}

function safeExtension(path: string): string {
  const extension = extname(path).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '';
}
