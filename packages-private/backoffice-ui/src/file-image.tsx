import { ImagePreview } from "@fragno-private/design-system/image-preview";
import { createContext, useContext, type ComponentType, type ReactNode } from "react";

type FileImageComponent = ComponentType<{ path: string; alt: string }>;

/** Outside a scope, such as in Storybook, no file can be fetched, so images show their alt text. */
function UnavailableFileImage({ alt }: { path: string; alt: string }) {
  return <ImagePreview src={null} alt={alt} />;
}

const FileImageContext = createContext<FileImageComponent>(UnavailableFileImage);

/** Shows the scope's files in generated images; only the host can fetch them for the viewer. */
export function FileImageProvider({
  component,
  children,
}: {
  component: FileImageComponent;
  children: ReactNode;
}) {
  return <FileImageContext value={component}>{children}</FileImageContext>;
}

export function useFileImage(): FileImageComponent {
  return useContext(FileImageContext);
}
