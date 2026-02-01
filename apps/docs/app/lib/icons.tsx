import { FragnoCircle as FragnoCircleIcon } from "@/components/logos/fragno-circle";
import { Stripe as StripeIcon } from "@/components/logos/stripe";
import { ShadCNUI } from "@/components/logos/shadcn-ui";

import {
  Album,
  TableOfContents,
  NotebookTabs,
  Frame,
  Terminal,
  CircleHelp,
  ClipboardList,
  ShieldCheck,
  FileBraces,
  Code,
  Workflow,
  Upload,
} from "lucide-react";

/**
 * Icon map: Only import icons actually used in your docs to minimize bundle size.
 * This includes custom icons and only the specific lucide-react icons referenced
 * in MDX frontmatter (icon: IconName) across all doc pages.
 */
export const iconComponents = {
  // Custom icons
  FragnoCircle: FragnoCircleIcon,
  Stripe: StripeIcon,
  ShadCNUI,
  // Lucide icons (only those used in content)
  Album,
  TableOfContents,
  NotebookTabs,
  Frame,
  Terminal,
  ClipboardList,
  ShieldCheck,
  FileBraces,
  Code,
  Workflow,
  Upload,
  CircleQuestionMark: CircleHelp, // Note: CircleQuestionMark -> CircleHelp in lucide-react
} as const;
