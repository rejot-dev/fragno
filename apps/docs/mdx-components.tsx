import { createGenerator } from "fumadocs-typescript";
import { AutoTypeTable } from "fumadocs-typescript/ui";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import * as TabsComponents from "fumadocs-ui/components/tabs";
import { Levels, Level } from "@/components/levels";

const generator = createGenerator();
// use this function to get MDX components, you will need it for rendering MDX
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    ...TabsComponents,
    ...components,
    Levels,
    Level,
    AutoTypeTable: (props) => (
      <AutoTypeTable {...props} generator={generator} options={{ basePath: "../../" }} />
    ),
  };
}
