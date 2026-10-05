/** Infers file MIME metadata from recognizable paths, falling back to generic binary content. */
export function inferFileContentType(path: string): string {
  const extension = /\.[^./]+$/u.exec(path)?.[0]?.toLowerCase() ?? "";
  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".md":
    case ".mdx":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".js":
    case ".jsx":
      return "text/javascript";
    case ".ts":
    case ".tsx":
      return "text/typescript";
    case ".htm":
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".sh":
      return "text/x-shellscript";
    default:
      return "application/octet-stream";
  }
}
