import type { StreamSearchEvent } from ".";
import type { SearchRequest } from "./schemas/search";

export class StreamingAirweaveClient {
  baseUrl: string;
  apiKey: string;

  constructor(options: { baseUrl?: string; apiKey: string }) {
    this.baseUrl = options.baseUrl || "https://api.airweave.ai";
    this.apiKey = options.apiKey;
  }

  searchUrl(collectionId: string) {
    return `${this.baseUrl}/collections/${collectionId}/search/stream`;
  }

  async *search(
    collectionId: string,
    params: SearchRequest,
  ): AsyncGenerator<StreamSearchEvent, void, unknown> {
    const url = this.searchUrl(collectionId);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[streamSearch] Request failed:", {
        status: response.status,
        statusText: response.statusText,
        body: errorText,
      });
      throw new Error(
        `Streaming search failed: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    if (!response.body) {
      throw new Error("Response body is null");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          const trimmedLine = line.trim();

          // Skip empty lines
          if (!trimmedLine) {
            continue;
          }

          // Parse SSE format (lines starting with "data: ")
          if (trimmedLine.startsWith("data: ")) {
            const jsonStr = trimmedLine.slice(6); // Remove "data: " prefix

            try {
              const event = JSON.parse(jsonStr) as StreamSearchEvent;
              yield event;
            } catch (error) {
              console.error("Failed to parse SSE event:", jsonStr, error);
              // Continue processing other events
            }
          }
        }
      }

      // Process any remaining data in buffer
      if (buffer.trim()) {
        const trimmedLine = buffer.trim();
        if (trimmedLine.startsWith("data: ")) {
          const jsonStr = trimmedLine.slice(6);
          try {
            const event = JSON.parse(jsonStr) as StreamSearchEvent;
            yield event;
          } catch (error) {
            console.error("Failed to parse final SSE event:", jsonStr, error);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
