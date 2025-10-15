import { source } from "@/lib/source";
import { NextRequest, NextResponse } from "next/server";
import { notFound } from "next/navigation";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug?: string[] }> },
) {
  const resolvedParams = await params;
  const page = source.getPage(resolvedParams.slug || []);

  if (!page) {
    notFound();
  }

  const markdownText = await page.data.getText("raw");

  return new NextResponse(markdownText, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}

// Generate static params for all possible markdown routes
export async function generateStaticParams() {
  const allParams = source.generateParams();

  // Return all the same params that the regular docs pages use
  // This ensures all .md routes are pre-rendered
  return allParams;
}
