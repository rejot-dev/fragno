import type {
  JsonFormsCellRendererRegistryEntry,
  JsonFormsRendererRegistryEntry,
} from "@jsonforms/core";

export * from "./controls";
export * from "./cells";
export * from "./layouts";
export * from "./additional";
export * from "./shadcn-controls";

import {
  shadcnBooleanControlTester,
  ShadcnBooleanControlContext,
  shadcnBooleanToggleControlTester,
  ShadcnBooleanToggleControlContext,
  shadcnTextControlTester,
  ShadcnTextControlContext,
  shadcnTextAreaControlTester,
  ShadcnTextAreaControlContext,
  shadcnDateControlTester,
  ShadcnDateControlContext,
  shadcnTimeControlTester,
  ShadcnTimeControlContext,
  shadcnDateTimeControlTester,
  ShadcnDateTimeControlContext,
  shadcnIntegerControlTester,
  ShadcnIntegerControlContext,
  shadcnNumberControlTester,
  ShadcnNumberControlContext,
  shadcnEnumControlTester,
  ShadcnEnumControlContext,
  shadcnEnumRadioControlTester,
  ShadcnEnumRadioControlContext,
  shadcnOneOfEnumControlTester,
  ShadcnOneOfEnumControlContext,
  shadcnSliderControlTester,
  ShadcnSliderControlContext,
  shadcnObjectControlTester,
  ShadcnObjectControlContext,
} from "./controls";

import {
  shadcnBooleanCellTester,
  ShadcnBooleanCellContext,
  shadcnBooleanToggleCellTester,
  ShadcnBooleanToggleCellContext,
  shadcnTextCellTester,
  ShadcnTextCellContext,
  shadcnDateCellTester,
  ShadcnDateCellContext,
  shadcnTimeCellTester,
  ShadcnTimeCellContext,
  shadcnDateTimeCellTester,
  ShadcnDateTimeCellContext,
  shadcnIntegerCellTester,
  ShadcnIntegerCellContext,
  shadcnNumberCellTester,
  ShadcnNumberCellContext,
  shadcnEnumCellTester,
  ShadcnEnumCellContext,
  shadcnEnumRadioCellTester,
  ShadcnEnumRadioCellContext,
  shadcnOneOfEnumCellTester,
  ShadcnOneOfEnumCellContext,
  shadcnSliderCellTester,
  ShadcnSliderCellContext,
} from "./cells";

import {
  shadcnVerticalLayoutTester,
  ShadcnVerticalLayoutContext,
  shadcnHorizontalLayoutTester,
  ShadcnHorizontalLayoutContext,
  shadcnGroupLayoutTester,
  ShadcnGroupLayoutContext,
  shadcnCategorizationLayoutTester,
  ShadcnCategorizationLayoutContext,
  shadcnCategorizationStepperLayoutTester,
  ShadcnCategorizationStepperLayoutContext,
} from "./layouts";

import { shadcnLabelRendererTester, ShadcnLabelRendererContext } from "./additional";

/**
 * Shadcn renderers for JSON Forms.
 * Register these with JSON Forms to use shadcn/ui components for form rendering.
 */
export const shadcnRenderers: JsonFormsRendererRegistryEntry[] = [
  {
    tester: shadcnCategorizationStepperLayoutTester,
    renderer: ShadcnCategorizationStepperLayoutContext,
  },
  { tester: shadcnCategorizationLayoutTester, renderer: ShadcnCategorizationLayoutContext },
  { tester: shadcnVerticalLayoutTester, renderer: ShadcnVerticalLayoutContext },
  { tester: shadcnHorizontalLayoutTester, renderer: ShadcnHorizontalLayoutContext },
  { tester: shadcnGroupLayoutTester, renderer: ShadcnGroupLayoutContext },
  { tester: shadcnDateTimeControlTester, renderer: ShadcnDateTimeControlContext },
  { tester: shadcnTimeControlTester, renderer: ShadcnTimeControlContext },
  { tester: shadcnDateControlTester, renderer: ShadcnDateControlContext },
  { tester: shadcnTextAreaControlTester, renderer: ShadcnTextAreaControlContext },
  { tester: shadcnBooleanToggleControlTester, renderer: ShadcnBooleanToggleControlContext },
  { tester: shadcnBooleanControlTester, renderer: ShadcnBooleanControlContext },
  { tester: shadcnTextControlTester, renderer: ShadcnTextControlContext },
  { tester: shadcnIntegerControlTester, renderer: ShadcnIntegerControlContext },
  { tester: shadcnNumberControlTester, renderer: ShadcnNumberControlContext },
  { tester: shadcnEnumControlTester, renderer: ShadcnEnumControlContext },
  { tester: shadcnEnumRadioControlTester, renderer: ShadcnEnumRadioControlContext },
  { tester: shadcnOneOfEnumControlTester, renderer: ShadcnOneOfEnumControlContext },
  { tester: shadcnSliderControlTester, renderer: ShadcnSliderControlContext },
  { tester: shadcnObjectControlTester, renderer: ShadcnObjectControlContext },
  { tester: shadcnLabelRendererTester, renderer: ShadcnLabelRendererContext },
];

/** Shadcn cells for JSON Forms (lightweight renderers for tables/arrays). */
export const shadcnCells: JsonFormsCellRendererRegistryEntry[] = [
  { tester: shadcnBooleanCellTester, cell: ShadcnBooleanCellContext },
  { tester: shadcnBooleanToggleCellTester, cell: ShadcnBooleanToggleCellContext },
  { tester: shadcnTextCellTester, cell: ShadcnTextCellContext },
  { tester: shadcnDateCellTester, cell: ShadcnDateCellContext },
  { tester: shadcnTimeCellTester, cell: ShadcnTimeCellContext },
  { tester: shadcnDateTimeCellTester, cell: ShadcnDateTimeCellContext },
  { tester: shadcnIntegerCellTester, cell: ShadcnIntegerCellContext },
  { tester: shadcnNumberCellTester, cell: ShadcnNumberCellContext },
  { tester: shadcnEnumCellTester, cell: ShadcnEnumCellContext },
  { tester: shadcnEnumRadioCellTester, cell: ShadcnEnumRadioCellContext },
  { tester: shadcnOneOfEnumCellTester, cell: ShadcnOneOfEnumCellContext },
  { tester: shadcnSliderCellTester, cell: ShadcnSliderCellContext },
];
