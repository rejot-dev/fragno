import { source } from "@/lib/source";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createRelativeLink } from "fumadocs-ui/mdx";
import { getMDXComponents } from "@/mdx-components";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { CopyMarkdownButton } from "@/components/copy-markdown-button";

export default async function Page(props: PageProps<"/docs/[[...slug]]">) {
  const params = await props.params;
  const page = source.getPage(params.slug);

  if (!page) {
    notFound();
  }

  const markdownText = await page.data.getText("raw");
  const MDXContent = page.data.body;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <div className="-mt-6 flex flex-row items-center gap-2 border-b pb-6 pt-2">
        <a
          href={`https://github.com/rejot-dev/fragno/tree/main/packages/docs/content/docs/${page.path}`}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            buttonVariants({
              color: "secondary",
              size: "sm",
              className: "gap-2",
            }),
          )}
        >
          Edit on GitHub
        </a>
        <CopyMarkdownButton markdownText={markdownText} />
      </div>
      <DocsBody>
        <MDXContent
          components={getMDXComponents({
            // this allows you to link to other pages with relative file paths
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps<"/docs/[[...slug]]">): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
