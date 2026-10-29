import {
  type BackofficeContextScope,
  parseBackofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { absoluteFilePathSchema } from "@fragno-private/backoffice-ui/absolute-file-path";
import { FileImageProvider } from "@fragno-private/backoffice-ui/file-image";
import { ButtonLink } from "@fragno-private/design-system/button";
import { Icon } from "@fragno-private/design-system/icon";
import { ImagePreview } from "@fragno-private/design-system/image-preview";
import { ImagePreviewCard } from "@fragno-private/design-system/image-preview-card";
import { createContext, useContext, type ReactNode } from "react";
import { Link } from "react-router";

import type { BackofficeResolvedScope } from "@/backoffice-runtime/resolved-scope";
import {
  filesExplorerPathFromScopePath,
  filesPreviewPath,
  filesScopeBasePath,
} from "@/routes/backoffice/files/scope";

const FileScopeContext = createContext<BackofficeResolvedScope | null>(null);
// Outside the Backoffice layout no other scope is known, so links into one stay plain text.
const LinkableScopesContext = createContext<LinkableScopes>(() => null);

/** Names a scope as this page's links need it, or null when the page cannot link to it. */
type LinkableScopes = (scope: BackofficeContextScope) => BackofficeResolvedScope | null;

/**
 * Resolves file paths in rendered content against a scope's files. Null leaves images as
 * placeholders and paths unlinked, for content from a scope the page cannot link to: a path names
 * a file only within its own scope.
 */
export function FileScopeProvider({
  scope,
  children,
}: {
  scope: BackofficeResolvedScope | null;
  children: ReactNode;
}) {
  return (
    <FileScopeContext.Provider value={scope}>
      <FileImageProvider component={FileImage}>{children}</FileImageProvider>
    </FileScopeContext.Provider>
  );
}

/** The scopes that links to files in another scope, such as an agent's, can open. */
export function LinkableScopesProvider({
  resolveScope,
  children,
}: {
  resolveScope: LinkableScopes;
  children: ReactNode;
}) {
  return (
    <LinkableScopesContext.Provider value={resolveScope}>{children}</LinkableScopesContext.Provider>
  );
}

/** The scope workspace paths below a FileScopeProvider belong to; null outside one. */
export function useFileScope(): BackofficeResolvedScope | null {
  return useContext(FileScopeContext);
}

export function FileImage({ path, alt }: { path: string; alt: string }) {
  const scope = useFileScope();
  const parsedPath = absoluteFilePathSchema.safeParse(path);
  if (!scope || !parsedPath.success) {
    return <ImagePreview src={null} alt={alt} />;
  }
  const filePath = parsedPath.data;
  return (
    <ImagePreviewCard
      src={filesPreviewPath(scope, filePath)}
      alt={alt}
      filename={filePath.split("/").at(-1)!}
      action={
        <ButtonLink
          variant="ghost"
          to={filesExplorerPathFromScopePath(filesScopeBasePath(scope), filePath)}
          aria-label={`Open ${filePath} in Files`}
          title={filePath}
          className="min-h-10 px-2 text-[11px] text-[var(--bo-muted)] no-underline hover:text-[var(--bo-accent-fg)]"
        >
          <Icon name="folder" className="size-3.5" strokeWidth={1.5} />
          Open in Files
        </ButtonLink>
      }
    />
  );
}

/** Opens a file in the scope's Files explorer; outside a scope, the mention stays plain content. */
export function FileLink({ path, children }: { path: string; children: ReactNode }) {
  const scope = useFileScope();
  if (!scope) {
    return children;
  }
  return (
    <Link to={filesExplorerPathFromScopePath(filesScopeBasePath(scope), path)} title={path}>
      {children}
    </Link>
  );
}

/** Opens a file in the scope a link names; a scope this page cannot link to leaves it plain. */
export function ScopedFileLink({
  scope,
  path,
  children,
}: {
  scope: string;
  path: string;
  children: ReactNode;
}) {
  return (
    <NamedFileScope scope={scope}>
      <FileLink path={path}>{children}</FileLink>
    </NamedFileScope>
  );
}

/** Shows an image from the scope it names; a scope this page cannot link to shows unavailable. */
export function ScopedFileImage({
  scope,
  path,
  alt,
}: {
  scope: string;
  path: string;
  alt: string;
}) {
  return (
    <NamedFileScope scope={scope}>
      <FileImage path={path} alt={alt} />
    </NamedFileScope>
  );
}

function NamedFileScope({ scope, children }: { scope: string; children: ReactNode }) {
  const resolveScope = useContext(LinkableScopesContext);
  return (
    <FileScopeProvider scope={resolveScope(parseBackofficeScopePathSegment(scope))}>
      {children}
    </FileScopeProvider>
  );
}
