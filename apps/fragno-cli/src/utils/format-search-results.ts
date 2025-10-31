interface SearchResult {
  id: string;
  type: "page" | "heading" | "text";
  content: string;
  breadcrumbs?: string[];
  contentWithHighlights?: Array<{
    type: string;
    content: string;
    styles?: { highlight?: boolean };
  }>;
  url: string;
}

interface MergedResult {
  url: string;
  urlWithMd: string;
  fullUrl: string;
  fullUrlWithMd: string;
  title?: string;
  breadcrumbs?: string[];
  type: "page" | "heading" | "text";
  sections: Array<{
    content: string;
    type: "page" | "heading" | "text";
  }>;
}

/**
 * Merge search results by URL, grouping sections and content under each URL (without hash)
 */
export function mergeResultsByUrl(results: SearchResult[], baseUrl: string): MergedResult[] {
  const mergedMap = new Map<string, MergedResult>();

  for (const result of results) {
    // Strip hash to get base URL for merging
    const baseUrlWithoutHash = result.url.split("#")[0];
    const existing = mergedMap.get(baseUrlWithoutHash);

    if (existing) {
      // Add this result as a section
      existing.sections.push({
        content: result.content,
        type: result.type,
      });
    } else {
      // Create new merged result
      const urlWithMd = `${baseUrlWithoutHash}.md`;

      const fullUrl = `https://${baseUrl}${baseUrlWithoutHash}`;
      const fullUrlWithMd = `https://${baseUrl}${urlWithMd}`;

      mergedMap.set(baseUrlWithoutHash, {
        url: baseUrlWithoutHash,
        urlWithMd,
        fullUrl,
        fullUrlWithMd,
        title: result.type === "page" ? result.content : undefined,
        breadcrumbs: result.breadcrumbs,
        type: result.type,
        sections: [
          {
            content: result.content,
            type: result.type,
          },
        ],
      });
    }
  }

  return Array.from(mergedMap.values());
}

/**
 * Format merged results as markdown
 */
export function formatAsMarkdown(mergedResults: MergedResult[]): string {
  const lines: string[] = [];

  for (const result of mergedResults) {
    // Title (use first section content if it's a page, or just use content)
    const title = result.title || result.sections[0]?.content || "Untitled";
    lines.push(`## Page: '${title}'`);
    // Breadcrumbs
    if (result.breadcrumbs && result.breadcrumbs.length > 0) {
      lines.push("   " + result.breadcrumbs.join(" > "));
      lines.push("");
    }

    // Both URLs
    lines.push("URLs:");
    lines.push(`  - ${result.fullUrl}`);
    lines.push(`  - ${result.fullUrlWithMd}`);
    lines.push("");

    // Show all sections found on this page
    if (result.sections.length > 1) {
      lines.push("Relevant sections:");
      for (let i = 0; i < result.sections.length; i++) {
        const section = result.sections[i];
        // Skip the first section if it's just the page title repeated
        if (i === 0 && result.type === "page" && section.content === result.title) {
          continue;
        }
        lines.push(`  - ${section.content}`);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format merged results as JSON
 */
export function formatAsJson(mergedResults: MergedResult[]): string {
  return JSON.stringify(mergedResults, null, 2);
}
