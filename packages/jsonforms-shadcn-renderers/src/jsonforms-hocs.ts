import type { ComponentType } from "react";

import type {
  CellProps,
  ControlProps,
  EnumCellProps,
  LabelProps,
  LayoutProps,
  OwnPropsOfCell,
  OwnPropsOfControl,
  OwnPropsOfEnum,
  OwnPropsOfEnumCell,
  OwnPropsOfLabel,
  OwnPropsOfLayout,
  StatePropsOfControlWithDetail,
} from "@jsonforms/core";
import {
  withJsonFormsCellProps as jsonFormsCellProps,
  withJsonFormsControlProps as jsonFormsControlProps,
  withJsonFormsDetailProps as jsonFormsDetailProps,
  withJsonFormsEnumCellProps as jsonFormsEnumCellProps,
  withJsonFormsEnumProps as jsonFormsEnumProps,
  withJsonFormsLabelProps as jsonFormsLabelProps,
  withJsonFormsLayoutProps as jsonFormsLayoutProps,
  withJsonFormsOneOfEnumCellProps as jsonFormsOneOfEnumCellProps,
  withJsonFormsOneOfEnumProps as jsonFormsOneOfEnumProps,
} from "@jsonforms/react";

export const withJsonFormsControlProps: (
  component: ComponentType<ControlProps>,
  memoize?: boolean,
) => ComponentType<OwnPropsOfControl> = jsonFormsControlProps;

export const withJsonFormsCellProps: (
  component: ComponentType<CellProps>,
  memoize?: boolean,
) => ComponentType<OwnPropsOfCell> = jsonFormsCellProps;

export const withJsonFormsLayoutProps: <T extends LayoutProps>(
  component: ComponentType<T>,
  memoize?: boolean,
) => ComponentType<T & OwnPropsOfLayout> = jsonFormsLayoutProps;

export const withJsonFormsEnumProps: (
  component: ComponentType<ControlProps & OwnPropsOfEnum>,
  memoize?: boolean,
) => ComponentType<OwnPropsOfControl & OwnPropsOfEnum> = jsonFormsEnumProps;

export const withJsonFormsOneOfEnumProps: (
  component: ComponentType<ControlProps & OwnPropsOfEnum>,
  memoize?: boolean,
) => ComponentType<OwnPropsOfControl & OwnPropsOfEnum> = jsonFormsOneOfEnumProps;

export const withJsonFormsEnumCellProps: (
  component: ComponentType<EnumCellProps>,
  memoize?: boolean,
) => ComponentType<OwnPropsOfEnumCell> = jsonFormsEnumCellProps;

export const withJsonFormsOneOfEnumCellProps: (
  component: ComponentType<EnumCellProps>,
  memoize?: boolean,
) => ComponentType<OwnPropsOfEnumCell> = jsonFormsOneOfEnumCellProps;

export const withJsonFormsDetailProps: (
  component: ComponentType<StatePropsOfControlWithDetail>,
  memoize?: boolean,
) => ComponentType<OwnPropsOfControl> = jsonFormsDetailProps;

export const withJsonFormsLabelProps: (
  component: ComponentType<LabelProps & OwnPropsOfEnum>,
  memoize?: boolean,
) => ComponentType<OwnPropsOfLabel> = jsonFormsLabelProps;
