import { randomUUID } from 'node:crypto';

import type { HarnessAdapter } from '../adapters/harness.js';
import type { Project } from '../project/kernel.js';
import { assertProjectDirectory } from '../project/project-directory.js';
import { ResumeNotSupportedError } from './session-errors.js';
import type { Conversation } from './workspace.js';

/**
 * Reattaches WAX conversations to native sessions created by an earlier
 * process. It owns the reserved-id bookkeeping so two concurrent resumes of the
 * same conversation id cannot both succeed; the Workspace keeps the public
 * method and its snapshot form.
 */
export class ConversationResumer {
  constructor(
    private readonly adapter: HarnessAdapter,
    private readonly conversations: Map<string, Conversation>,
    private readonly resuming: Set<string>,
    private readonly assertRunning: () => void,
  ) {}

  async resume(
    project: Project,
    nativeId: string,
    conversationId?: string,
  ): Promise<Conversation> {
    this.assertRunning();
    assertProjectDirectory(project.directory);
    const resume = this.assertResumable(conversationId);
    if (conversationId !== undefined) {
      // Reserve the id before awaiting the native call so two concurrent
      // resumes of the same id cannot both succeed.
      this.resuming.add(conversationId);
    }
    const storedProject: Project = { id: project.id, directory: project.directory };
    try {
      await resume(nativeId, storedProject.directory);
    } catch (error) {
      if (conversationId !== undefined) {
        this.resuming.delete(conversationId);
      }
      throw error;
    }
    const conversation: Conversation = {
      id: conversationId ?? randomUUID(),
      project: storedProject,
      nativeId,
      displayName: nativeId,
    };
    this.conversations.set(conversation.id, conversation);
    if (conversationId !== undefined) {
      this.resuming.delete(conversationId);
    }
    return conversation;
  }

  private assertResumable(
    conversationId: string | undefined,
  ): (nativeId: string, cwd: string) => Promise<void> {
    const resume = this.adapter.resume;
    if (this.adapter.capabilities.resume !== true || resume === undefined) {
      throw new ResumeNotSupportedError();
    }
    if (conversationId !== undefined && (this.conversations.has(conversationId) || this.resuming.has(conversationId))) {
      throw new Error(`Conversation already exists or is being resumed: ${conversationId}`);
    }
    return resume.bind(this.adapter);
  }
}
