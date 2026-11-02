import { z } from "zod";

export const markdownDefinition = {
  props: z.strictObject({
    text: z.string().max(20_000),
  }),
  slots: [],
  description:
    "Renders Markdown prose, such as a page's Markdown file body: headings, lists, tables, links, and code. Workspace paths link to their files, and images of workspace files show; raw HTML does not render.",
  example: {
    text: "## Q4 plan\n\n- Ship the **delivery tracker**\n- Review [the budget](/workspace/finance/budget.csv)",
  },
};
