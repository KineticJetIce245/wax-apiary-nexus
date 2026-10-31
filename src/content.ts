/**
 * Execution result content. This is a presentation-neutral envelope: text plus
 * references to local files produced by a native Harness. Binary data is never
 * embedded here; the path is local and must not be exposed to a browser before
 * an artifact/authorization layer exists.
 */

export type AttachmentKind = 'image' | 'file';

export interface AttachmentDraft {
  readonly kind: AttachmentKind;
  readonly path: string;
  readonly mimeType: string;
  readonly name?: string;
  readonly byteLength?: number;
}

export interface Attachment extends AttachmentDraft {
  readonly id: string;
}

export type ResultPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: Attachment }
  | { readonly type: 'file'; readonly attachment: Attachment }
  | { readonly type: 'link'; readonly href: string; readonly title?: string };

export interface ResultSource {
  readonly connection: string;
  readonly executionId: string;
  readonly nativeId: string;
}

export interface ResultEnvelope {
  readonly version: 1;
  readonly parts: readonly ResultPart[];
  readonly source: ResultSource;
}

export interface BuildResultEnvelopeInput {
  readonly source: ResultSource;
  readonly output: string;
  readonly attachments: readonly Attachment[];
}

/**
 * Build the display/transport envelope for one execution. Text stays first for
 * compatibility and accessibility; attachments follow in arrival order.
 * Unknown attachment kinds are not silently coerced: the union is closed.
 */
export function buildResultEnvelope(input: BuildResultEnvelopeInput): ResultEnvelope {
  const parts: ResultPart[] = [];
  if (input.output !== '') {
    parts.push({ type: 'text', text: input.output });
  }
  for (const attachment of input.attachments) {
    parts.push(
      attachment.kind === 'image'
        ? { type: 'image', attachment: cloneAttachment(attachment) }
        : { type: 'file', attachment: cloneAttachment(attachment) },
    );
  }
  return { version: 1, parts, source: { ...input.source } };
}

export function cloneAttachment(attachment: Attachment): Attachment {
  return { ...attachment };
}
