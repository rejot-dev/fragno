import type { LabelProps, RankedTester } from "@jsonforms/core";
import { rankWith, uiTypeIs } from "@jsonforms/core";
import { withJsonFormsLabelProps } from "@jsonforms/react";
import { Label } from "@/components/ui/label";

/**
 * Default tester for a label.
 */
export const shadcnLabelRendererTester: RankedTester = rankWith(1, uiTypeIs("Label"));

/**
 * Default renderer for a label.
 * Renders static text without any associated data field.
 */
export const ShadcnLabelRenderer = ({ text, visible }: LabelProps) => {
  if (!visible) {
    return null;
  }

  return <Label>{text}</Label>;
};

export const ShadcnLabelRendererContext = withJsonFormsLabelProps(ShadcnLabelRenderer);
