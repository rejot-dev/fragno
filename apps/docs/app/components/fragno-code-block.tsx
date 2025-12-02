"use client";
import type {
  HighlightOptions,
  HighlightOptionsCommon,
  HighlightOptionsThemes,
} from "fumadocs-core/highlight";
import { useShiki } from "fumadocs-core/highlight/client";
import { cn } from "@/lib/cn";
import { type ComponentProps, createContext, type FC, Suspense, use } from "react";
import { CodeBlock, Pre, type CodeBlockProps } from "fumadocs-ui/components/codeblock";

export interface DynamicCodeblockProps {
  lang: string;
  code: string;
  /**
   * Extra props for the underlying `<CodeBlock />` component.
   *
   * Ignored if you defined your own `pre` component in `options.components`.
   */
  codeblock?: CodeBlockProps;
  /**
   * Wrap in React `<Suspense />` and provide a fallback.
   *
   * @defaultValue true
   */
  wrapInSuspense?: boolean;
  options?: Partial<Omit<HighlightOptionsCommon, "lang"> & HighlightOptionsThemes>;
  className?: string;
  /**
   * Show/hide the copy button.
   *
   * @defaultValue true
   */
  allowCopy?: boolean;
}

const PropsContext = createContext<CodeBlockProps | undefined>(undefined);

function DefaultPre(props: ComponentProps<"pre">) {
  const extraProps = use(PropsContext);

  return (
    <CodeBlock
      {...props}
      {...extraProps}
      className={cn(
        "my-0 grid w-full min-w-0 max-w-full overflow-x-auto",
        props.className,
        extraProps?.className,
      )}
    >
      <Pre>{props.children}</Pre>
    </CodeBlock>
  );
}

export function FragnoCodeBlock({
  lang,
  code,
  codeblock,
  options,
  wrapInSuspense = true,
  className,
  allowCopy = true,
}: DynamicCodeblockProps) {
  const shikiOptions = {
    lang,
    ...options,
    components: {
      pre: DefaultPre,
      ...options?.components,
    },
  } satisfies HighlightOptions;
  let children = <Internal code={code} options={shikiOptions} />;

  if (wrapInSuspense) {
    children = (
      <Suspense fallback={<Placeholder code={code} components={shikiOptions.components} />}>
        {children}
      </Suspense>
    );
  }

  const mergedCodeblock = {
    ...codeblock,
    className: cn(codeblock?.className, className),
    allowCopy,
  };

  return <PropsContext value={mergedCodeblock}>{children}</PropsContext>;
}

function Placeholder({
  code,
  components = {},
}: {
  code: string;
  components: HighlightOptions["components"];
}) {
  const { pre: Pre = "pre", code: Code = "code" } = components as Record<string, FC>;

  return (
    <Pre className="my-0 block w-full min-w-0 max-w-full overflow-x-auto">
      <Code className="block w-fit min-w-full">
        {code.split("\n").map((line, i) => (
          <span key={i} className="line">
            {line}
          </span>
        ))}
      </Code>
    </Pre>
  );
}

function Internal({ code, options }: { code: string; options: HighlightOptions }) {
  return useShiki(code, options);
}
