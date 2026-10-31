import { randomUUID } from 'node:crypto';
import { statSync, type Stats } from 'node:fs';
import { resolve } from 'node:path';

export interface Project {
  readonly id: string;
  readonly directory: string;
}

export interface Kernel {
  registerProject(directory: string, id?: string): Project;
  getProject(id: string): Project | null;
}

export function createKernel(): Kernel {
  const projects = new Map<string, Project>();

  return {
    registerProject(directory, id) {
      const projectId = id ?? randomUUID();
      const resolvedDirectory = resolve(directory);
      assertDirectory(resolvedDirectory);
      if (projects.has(projectId)) {
        throw new Error(`Project ID "${projectId}" is already registered`);
      }

      const project: Project = { id: projectId, directory: resolvedDirectory };
      projects.set(projectId, project);
      return project;
    },

    getProject(id) {
      return projects.get(id) ?? null;
    },
  };
}

function assertDirectory(directory: string): void {
  let stats: Stats;
  try {
    stats = statSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Project directory does not exist: ${directory}`);
    }
    throw error;
  }

  if (!stats.isDirectory()) {
    throw new Error(`Project path is not a directory: ${directory}`);
  }
}
