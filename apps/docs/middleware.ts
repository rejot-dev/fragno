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

  if (request.nextUrl.pathname.endsWith(".md")) {
    const pathWithoutMd = request.nextUrl.pathname.replace(/\.md$/, "");

    const result = rewrite(pathWithoutMd);

    if (result) {
      return NextResponse.rewrite(new URL(result, request.nextUrl));
    }
  }

  return NextResponse.next();
}
