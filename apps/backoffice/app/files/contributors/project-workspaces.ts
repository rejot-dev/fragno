import { z } from "zod";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import {
  createPathNotFoundFileSystemError,
  createUnsupportedOperationFileSystemError,
} from "@/files/fs-errors";
import type {
  BufferEncoding,
  CpOptions,
  DirentEntry,
  FileContent,
  FsStat,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  WriteFileOptions,
} from "@/files/interface";
import { createUnsupportedFileSystem, type IFileSystem } from "@/files/interface";
import { normalizeAbsolutePath, stripTrailingSlash } from "@/files/normalize-path";
import { createSystemFilesContext } from "@/files/system-context";
import type { FileContributor, FilesContext } from "@/files/types";

import { createUploadFileSystem } from "./upload";

const PROJECTS_MOUNT_POINT = "/projects";
const DATABASE_UPLOAD_PROVIDER = "database";

const projectsResponseSchema = z.array(
  z.object({
    id: z.unknown(),
    slug: z.string().trim().min(1),
  }),
);

type ProjectMountEntry = {
  id: string;
  slug: string;
};

const projectIdString = (id: unknown): string =>
  typeof id === "object" && id && "externalId" in id
    ? String((id as { externalId: unknown }).externalId)
    : String((id as { valueOf?: () => unknown }).valueOf?.() ?? id);

const directoryStat = (): FsStat => ({
  isFile: false,
  isDirectory: true,
  isSymbolicLink: false,
  mode: 0o755,
  size: 0,
  mtime: new Date(0),
});

const rootDirent = (name: string): DirentEntry => ({
  name,
  isFile: false,
  isDirectory: true,
  isSymbolicLink: false,
});

const loadProjects = async (ctx: FilesContext): Promise<ProjectMountEntry[]> => {
  if (!ctx.objects || ctx.execution.scope.kind !== "org") {
    return [];
  }

  const automations = ctx.kernel.scoped(
    "AUTOMATIONS",
    ctx.execution.scope,
    ctx.objects.automations,
  );
  const url = new URL("https://automations.local/api/automations/projects");
  url.searchParams.set("orgId", ctx.execution.scope.orgId);
  const response = await automations.fetch(new Request(url));
  if (!response.ok) {
    throw new Error(`Failed to load project workspaces (${response.status}).`);
  }

  const projects = projectsResponseSchema.parse(await response.json());
  return projects.map((project) => ({ id: projectIdString(project.id), slug: project.slug }));
};

type ResolvedProjectPath =
  | { kind: "root"; path: string }
  | { kind: "project"; path: string; project: ProjectMountEntry; fs: IFileSystem };

const createProjectExecution = (
  ctx: FilesContext,
  project: ProjectMountEntry,
): BackofficeExecutionContext => {
  if (ctx.execution.scope.kind !== "org") {
    throw createPathNotFoundFileSystemError("resolve", `${PROJECTS_MOUNT_POINT}/${project.slug}`);
  }

  return {
    actor: ctx.execution.actor,
    scope: { kind: "project", orgId: ctx.execution.scope.orgId, projectId: project.id },
  };
};

const resolveProjectPath = async (
  ctx: FilesContext,
  path: string,
): Promise<ResolvedProjectPath> => {
  const normalizedPath = normalizeAbsolutePath(path);
  const stripped = stripTrailingSlash(normalizedPath);
  if (stripped === PROJECTS_MOUNT_POINT) {
    return { kind: "root", path: normalizedPath };
  }

  if (!stripped.startsWith(`${PROJECTS_MOUNT_POINT}/`)) {
    throw createPathNotFoundFileSystemError("resolve", path);
  }

  const slug = stripped.slice(PROJECTS_MOUNT_POINT.length + 1).split("/", 1)[0];
  const project = (await loadProjects(ctx)).find((entry) => entry.slug === slug);
  if (!project) {
    throw createPathNotFoundFileSystemError("resolve", path);
  }

  const execution = createProjectExecution(ctx, project);
  const fs = createUploadFileSystem(
    createSystemFilesContext({
      origin: ctx.origin,
      request: ctx.request,
      objects: ctx.objects,
      execution,
      filePrincipal: ctx.kernel.resolveFilePrincipal(execution),
      staticFileArtifacts: ctx.staticFileArtifacts,
    }),
    {
      mountPoint: `${PROJECTS_MOUNT_POINT}/${project.slug}`,
      provider: DATABASE_UPLOAD_PROVIDER,
    },
  );

  return { kind: "project", path: normalizedPath, project, fs };
};

const projectWorkspacesFileSystem = (ctx: FilesContext): IFileSystem =>
  createUnsupportedFileSystem(createUnsupportedOperationFileSystemError, {
    async readFile(path: string, options?: ReadFileOptions | BufferEncoding) {
      const resolved = await resolveProjectPath(ctx, path);
      if (resolved.kind === "root") {
        throw createUnsupportedOperationFileSystemError("read", path);
      }
      return await resolved.fs.readFile(path, options);
    },
    async readFileBuffer(path: string) {
      const resolved = await resolveProjectPath(ctx, path);
      if (resolved.kind === "root") {
        throw createUnsupportedOperationFileSystemError("read", path);
      }
      return await resolved.fs.readFileBuffer(path);
    },
    async writeFile(
      path: string,
      content: FileContent,
      options?: WriteFileOptions | BufferEncoding,
    ) {
      const resolved = await resolveProjectPath(ctx, path);
      if (resolved.kind === "root") {
        throw createUnsupportedOperationFileSystemError("write", path);
      }
      await resolved.fs.writeFile(path, content, options);
    },
    async appendFile(
      path: string,
      content: FileContent,
      options?: WriteFileOptions | BufferEncoding,
    ) {
      const resolved = await resolveProjectPath(ctx, path);
      if (resolved.kind === "root") {
        throw createUnsupportedOperationFileSystemError("append", path);
      }
      await resolved.fs.appendFile(path, content, options);
    },
    async stat(path: string) {
      const resolved = await resolveProjectPath(ctx, path);
      if (resolved.kind === "root") {
        return directoryStat();
      }
      return await resolved.fs.stat(path);
    },
    async mkdir(path: string, options?: MkdirOptions) {
      const resolved = await resolveProjectPath(ctx, path);
      if (resolved.kind === "root") {
        throw createUnsupportedOperationFileSystemError("mkdir", path);
      }
      await resolved.fs.mkdir(path, options);
    },
    async readdir(path: string) {
      const resolved = await resolveProjectPath(ctx, path);
      if (resolved.kind === "root") {
        return (await loadProjects(ctx)).map((project) => project.slug).sort();
      }
      return await resolved.fs.readdir(path);
    },
    async readdirWithFileTypes(path: string) {
      const resolved = await resolveProjectPath(ctx, path);
      if (resolved.kind === "root") {
        return (await loadProjects(ctx))
          .map((project) => rootDirent(project.slug))
          .sort((left, right) => left.name.localeCompare(right.name));
      }
      return resolved.fs.readdirWithFileTypes
        ? await resolved.fs.readdirWithFileTypes(path)
        : (await resolved.fs.readdir(path)).map((name) => rootDirent(name));
    },
    async rm(path: string, options?: RmOptions) {
      const resolved = await resolveProjectPath(ctx, path);
      if (resolved.kind === "root") {
        throw createUnsupportedOperationFileSystemError("remove", path);
      }
      await resolved.fs.rm(path, options);
    },
    async cp(src: string, dest: string, options?: CpOptions) {
      const source = await resolveProjectPath(ctx, src);
      const target = await resolveProjectPath(ctx, dest);
      if (
        source.kind === "root" ||
        target.kind === "root" ||
        source.project.id !== target.project.id
      ) {
        throw createUnsupportedOperationFileSystemError("copy", src);
      }
      await source.fs.cp(src, dest, options);
    },
    async mv(src: string, dest: string) {
      const source = await resolveProjectPath(ctx, src);
      const target = await resolveProjectPath(ctx, dest);
      if (
        source.kind === "root" ||
        target.kind === "root" ||
        source.project.id !== target.project.id
      ) {
        throw createUnsupportedOperationFileSystemError("move", src);
      }
      await source.fs.mv(src, dest);
    },
    async chmod(path: string, mode: number) {
      const resolved = await resolveProjectPath(ctx, path);
      if (resolved.kind === "root") {
        throw createUnsupportedOperationFileSystemError("chmod", path);
      }
      await resolved.fs.chmod(path, mode);
    },
    async realpath(path: string) {
      const resolved = await resolveProjectPath(ctx, path);
      if (resolved.kind === "root") {
        return PROJECTS_MOUNT_POINT;
      }
      return await resolved.fs.realpath(path);
    },
    async utimes(path: string, atime: Date, mtime: Date) {
      const resolved = await resolveProjectPath(ctx, path);
      if (resolved.kind === "root") {
        throw createUnsupportedOperationFileSystemError("utimes", path);
      }
      await resolved.fs.utimes(path, atime, mtime);
    },
  });

export const projectWorkspacesFileContributor: FileContributor = {
  id: "project-workspaces",
  kind: "custom",
  mountPoint: PROJECTS_MOUNT_POINT,
  title: "Projects",
  readOnly: false,
  persistence: "persistent",
  description: "Project-scoped db-backed workspaces mounted by project slug.",
  ...createUnsupportedFileSystem(createUnsupportedOperationFileSystemError),
  createFileSystem(ctx) {
    if (ctx.execution.scope.kind !== "org" || !ctx.objects?.automations || !ctx.objects.upload) {
      return null;
    }

    return projectWorkspacesFileSystem(ctx);
  },
};
