import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { assertProjectDirectory } from './project-directory.js';

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
      assertProjectDirectory(resolvedDirectory);
      if (projects.has(projectId)) {
        throw new Error(`Project ID "${projectId}" is already registered`);
      }

      const project: Project = { id: projectId, directory: resolvedDirectory };
      projects.set(projectId, project);
      return { ...project };
    },

    getProject(id) {
      const project = projects.get(id);
      return project ? { ...project } : null;
    },
  };
}
