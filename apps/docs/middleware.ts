import { NextRequest, NextResponse } from "next/server";
import { isMarkdownPreferred, rewritePath } from "fumadocs-core/negotiation";

const { rewrite } = rewritePath("/docs/*path", "/api/markdown/*path");

export function middleware(request: NextRequest) {
  if (isMarkdownPreferred(request)) {
    // Accept header is text/markdown
    const result = rewrite(request.nextUrl.pathname);

    if (result) {
      return NextResponse.rewrite(new URL(result, request.nextUrl));
    }
  }

  if (request.nextUrl.pathname.endsWith(".md") || request.nextUrl.pathname.endsWith(".mdx")) {
    const pathWithoutExtension = request.nextUrl.pathname.replace(/\.mdx?$/, "");

    // Special case: /docs.md or /docs.mdx should map to /api/markdown (the index)
    if (pathWithoutExtension === "/docs") {
      return NextResponse.rewrite(new URL("/api/markdown", request.nextUrl));
    }

    const result = rewrite(pathWithoutExtension);

    if (result) {
      return NextResponse.rewrite(new URL(result, request.nextUrl));
    }
  }

  return NextResponse.next();
}
