import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import * as TabsComponents from "fumadocs-ui/components/tabs";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  const result = {
    ...defaultMdxComponents,
    ...TabsComponents,
    ...components,
  };

  // Check for undefined components
  Object.entries(result).forEach(([key, value]) => {
    if (value === undefined) {
      throw new Error(`[DEBUG] ❌ Component "${key}" is UNDEFINED`);
    }
  });

  return result;
}
