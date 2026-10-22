import { absoluteFilePathSchema } from "@fragno-private/backoffice-ui/absolute-file-path";
import { FileImageProvider } from "@fragno-private/backoffice-ui/file-image";
import { ButtonLink } from "@fragno-private/design-system/button";
import { Icon } from "@fragno-private/design-system/icon";
import { ImagePreview } from "@fragno-private/design-system/image-preview";
import { ImagePreviewCard } from "@fragno-private/design-system/image-preview-card";
import { createContext, useContext, type ReactNode } from "react";

import type { BackofficeResolvedScope } from "@/backoffice-runtime/resolved-scope";
import {
  filesExplorerPathFromScopePath,
  filesPreviewPath,
  filesScopeBasePath,
} from "@/routes/backoffice/files/scope";

const FileImageScopeContext = createContext<BackofficeResolvedScope | null>(null);

export function FileImageScopeProvider({
  scope,
  children,
}: {
  scope: BackofficeResolvedScope;
  children: ReactNode;
}) {
  return (
    <FileImageScopeContext.Provider value={scope}>
      <FileImageProvider component={FileImage}>{children}</FileImageProvider>
    </FileImageScopeContext.Provider>
  );
}

export function FileImage({ path, alt }: { path: string; alt: string }) {
  const scope = useContext(FileImageScopeContext);
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
