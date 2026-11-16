import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteJson } from '../storage/atomic-write.js';
import { BObjectValidationError, parseHiveTemplate } from './validation.js';
import type { HiveTemplate } from './types.js';

export type { HiveTemplate, SessionParams } from './types.js';

export class HiveTemplateStoreError extends Error {
  constructor(
    readonly path: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HiveTemplateStoreError';
  }
}

/**
 * One JSON file per template under a directory. Templates hold only structure
 * and per-bee session defaults; they never hold a field, session or binding.
 */
export class HiveTemplateStore {
  constructor(readonly directory: string) {
    if (typeof directory !== 'string' || directory.length === 0) {
      throw new TypeError('HiveTemplateStore directory must be a non-empty string');
    }
  }

  load(templateId: string): HiveTemplate {
    const path = this.pathFor(templateId);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw new HiveTemplateStoreError(path, `cannot read hive template: ${path}`, {
        cause: error,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new HiveTemplateStoreError(path, `hive template is not valid JSON: ${path}`, {
        cause: error,
      });
    }

    try {
      const template = parseHiveTemplate(parsed);
      if (template.templateId !== templateId) {
        throw new BObjectValidationError([
          `template.templateId: expected '${templateId}'`,
        ]);
      }
      return template;
    } catch (error) {
      if (error instanceof BObjectValidationError) {
        throw new HiveTemplateStoreError(path, `hive template is invalid: ${path}`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  save(template: HiveTemplate): void {
    parseHiveTemplate(template);
    const path = this.pathFor(template.templateId);
    atomicWriteJson(path, template);
  }

  /** Load every template in the directory, sorted by templateId. */
  list(): readonly HiveTemplate[] {
    if (!existsSync(this.directory)) {
      return [];
    }
    let names: readonly string[];
    try {
      names = readdirSync(this.directory);
    } catch (error) {
      throw new HiveTemplateStoreError(
        this.directory,
        `cannot list hive templates: ${this.directory}`,
        { cause: error },
      );
    }
    const templates: HiveTemplate[] = [];
    for (const name of [...names].sort()) {
      if (!name.endsWith('.json')) {
        continue;
      }
      templates.push(this.load(name.slice(0, -'.json'.length)));
    }
    return templates;
  }

  private pathFor(templateId: string): string {
    if (
      typeof templateId !== 'string' ||
      templateId.length === 0 ||
      templateId.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(templateId) ||
      templateId === '.' ||
      templateId === '..'
    ) {
      throw new HiveTemplateStoreError(
        this.directory,
        'templateId must be a safe file name',
      );
    }
    return join(this.directory, `${templateId}.json`);
  }
}
