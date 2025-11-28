import type { Route } from "./+types/markdown";
import { source } from "@/lib/source";

export async function loader({ params }: Route.LoaderArgs) {
  const splat = params["*"]?.replace(/\.mdx?$/, "");

  const slugs = splat.split("/").filter((v) => v.length > 0);
  const page = source.getPage(slugs);

  if (!page) {
    throw new Response("Not found", { status: 404 });
  }

  const markdownText = await page.data.getText("processed");

  return new Response(markdownText, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
