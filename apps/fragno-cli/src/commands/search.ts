import { define } from "gunshi";
import {
  mergeResultsByUrl,
  formatAsMarkdown,
  formatAsJson,
} from "../utils/format-search-results.js";

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

export const searchCommand = define({
  name: "search",
  description: "Search the Fragno documentation",
  args: {
    limit: {
      type: "number",
      description: "Maximum number of results to show",
      default: 10,
    },
    json: {
      type: "boolean",
      description: "Output results in JSON format",
      default: false,
    },
    markdown: {
      type: "boolean",
      description: "Output results in Markdown format (default)",
      default: true,
    },
    "base-url": {
      type: "string",
      description: "Base URL for the documentation site",
      default: "fragno.dev",
    },
  },
  run: async (ctx) => {
    const query = ctx.positionals.join(" ");

    if (!query || query.trim().length === 0) {
      throw new Error("Please provide a search query");
    }

    // Determine output mode
    const jsonMode = ctx.values.json as boolean;
    const baseUrl = ctx.values["base-url"] as string;

    if (!jsonMode) {
      console.log(`Searching for: "${query}"\n`);
    }

    try {
      // Make request to the docs search API
      const encodedQuery = encodeURIComponent(query);
      const response = await fetch(`https://${baseUrl}/api/search?query=${encodedQuery}`);

      if (!response.ok) {
        throw new Error(`API request failed with status ${response.status}`);
      }

      const results = (await response.json()) as SearchResult[];

      // Apply limit
      const limit = ctx.values.limit as number;
      const limitedResults = results.slice(0, limit);

      if (limitedResults.length === 0) {
        if (jsonMode) {
          console.log("[]");
        } else {
          console.log("No results found.");
        }
        return;
      }

      // Merge results by URL
      const mergedResults = mergeResultsByUrl(limitedResults, baseUrl);

      // Output based on mode
      if (jsonMode) {
        console.log(formatAsJson(mergedResults));
      } else {
        // Markdown mode (default)
        console.log(
          `Found ${results.length} result${results.length === 1 ? "" : "s"}${results.length > limit ? ` (showing ${limit})` : ""}\n`,
        );
        console.log(formatAsMarkdown(mergedResults));
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Search failed: ${error.message}`);
      }
      throw new Error("Search failed: An unknown error occurred");
    }
  },
});
