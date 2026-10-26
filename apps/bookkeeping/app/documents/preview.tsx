import { ButtonLink } from "@fragno-private/design-system/button";
import { Icon } from "@fragno-private/design-system/icon";
import { SurfaceSection } from "@fragno-private/design-system/surface-panel";

import { documentPath } from "../books/books";

/** A document's file, shown on the page, with a way to open it on its own. */
export function DocumentPreview({
  base,
  document,
}: {
  base: string;
  document: { id: string; filename: string; mediaType: string };
}) {
  const src = `${documentPath(base, document.id)}/file`;
  return (
    <SurfaceSection
      title={document.filename}
      meta={null}
      actions={
        <ButtonLink variant="ghost" to={src} target="_blank" rel="noreferrer" reloadDocument>
          <Icon name="external-link" className="size-4" />
          Open
        </ButtonLink>
      }
    >
      <div className="border-t border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
        {document.mediaType === "application/pdf" ? (
          <iframe src={src} title={document.filename} className="block h-[60vh] w-full" />
        ) : (
          <img
            src={src}
            alt={document.filename}
            className="mx-auto block max-h-[60vh] w-auto object-contain"
          />
        )}
      </div>
    </SurfaceSection>
  );
}
