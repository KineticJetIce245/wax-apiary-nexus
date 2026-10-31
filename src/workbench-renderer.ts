import type { TaggedWorkspaceEvent } from './workbench.js';

export interface RenderState {
  lastOutputKey: string | undefined;
}

export function createRenderState(): RenderState {
  return { lastOutputKey: undefined };
}

/**
 * Render output/tool/state events with a source label whenever the stream
 * changes. Interleaved assistant chunks from two connections must not appear
 * as one continuous run of text; a tool or state line also breaks the run so
 * the next chunk is labelled again.
 */
export function renderTaggedEvent(
  tagged: TaggedWorkspaceEvent,
  state: RenderState,
  write: (text: string) => void,
): void {
  const { connection, event } = tagged;
  switch (event.type) {
    case 'execution/output': {
      if (event.channel !== 'assistant') {
        return;
      }
      const key = `${connection}:${event.executionId}`;
      if (state.lastOutputKey !== key) {
        write(`\n[${connection}:${event.executionId.slice(0, 8)}] `);
        state.lastOutputKey = key;
      }
      write(event.text);
      return;
    }
    case 'execution/tool': {
      state.lastOutputKey = undefined;
      write(`\n[${connection}] tool ${event.title} ${event.status}\n`);
      return;
    }
    case 'execution/state': {
      state.lastOutputKey = undefined;
      write(
        `\n[${connection}] execution ${event.executionId.slice(0, 8)} ${event.state}` +
          `${event.stopReason === undefined ? '' : ` (${event.stopReason})`}\n`,
      );
      return;
    }
    default:
      return;
  }
}
