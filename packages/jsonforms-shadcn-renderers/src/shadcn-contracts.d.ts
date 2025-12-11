/**
 * Type contracts for shadcn/ui components.
 *
 * This library uses @/components/ui/* imports that are external dependencies.
 * Consumers must provide these components via their shadcn/ui installation.
 *
 * These declarations provide the type contracts that the library expects.
 */

// Button
declare module "@/components/ui/button" {
  import type * as React from "react";
  export interface ButtonProps extends React.ComponentProps<"button"> {
    variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
    size?: "default" | "sm" | "lg" | "icon" | "icon-sm" | "icon-lg";
    asChild?: boolean;
  }
  export const Button: React.FC<ButtonProps>;
}

// Calendar
declare module "@/components/ui/calendar" {
  import type * as React from "react";
  import type { DayPickerProps } from "react-day-picker";
  export type CalendarProps = DayPickerProps;
  export const Calendar: React.FC<CalendarProps>;
}

// Card
declare module "@/components/ui/card" {
  import type * as React from "react";
  export const Card: React.FC<React.ComponentProps<"div">>;
  export const CardHeader: React.FC<React.ComponentProps<"div">>;
  export const CardTitle: React.FC<React.ComponentProps<"div">>;
  export const CardDescription: React.FC<React.ComponentProps<"div">>;
  export const CardAction: React.FC<React.ComponentProps<"div">>;
  export const CardContent: React.FC<React.ComponentProps<"div">>;
  export const CardFooter: React.FC<React.ComponentProps<"div">>;
}

// Checkbox
declare module "@/components/ui/checkbox" {
  import type * as React from "react";
  export interface CheckboxProps {
    checked?: boolean | "indeterminate";
    defaultChecked?: boolean | "indeterminate";
    onCheckedChange?: (checked: boolean | "indeterminate") => void;
    disabled?: boolean;
    required?: boolean;
    name?: string;
    value?: string;
    id?: string;
    className?: string;
  }
  export const Checkbox: React.FC<CheckboxProps>;
}

// Field
declare module "@/components/ui/field" {
  import type * as React from "react";
  export const Field: React.FC<
    React.HTMLAttributes<HTMLDivElement> & {
      orientation?: "vertical" | "horizontal" | "responsive";
    }
  >;
  export const FieldSet: React.FC<React.ComponentProps<"fieldset">>;
  export const FieldGroup: React.FC<React.HTMLAttributes<HTMLDivElement>>;
  export const FieldLabel: React.FC<React.LabelHTMLAttributes<HTMLLabelElement>>;
  export const FieldDescription: React.FC<React.HTMLAttributes<HTMLParagraphElement>>;
  export const FieldError: React.FC<
    React.HTMLAttributes<HTMLDivElement> & {
      errors?: Array<{ message?: string } | undefined>;
    }
  >;
  export const FieldSeparator: React.FC<React.HTMLAttributes<HTMLDivElement>>;
  export const FieldContent: React.FC<React.HTMLAttributes<HTMLDivElement>>;
  export const FieldTitle: React.FC<React.HTMLAttributes<HTMLDivElement>>;
  export const FieldLegend: React.FC<
    React.ComponentProps<"legend"> & { variant?: "legend" | "label" }
  >;
}

// Input
declare module "@/components/ui/input" {
  import type * as React from "react";
  export const Input: React.FC<React.ComponentProps<"input">>;
}

// Label
declare module "@/components/ui/label" {
  import type * as React from "react";
  export const Label: React.FC<React.ComponentProps<"label">>;
}

// Popover
declare module "@/components/ui/popover" {
  import type * as React from "react";
  export interface PopoverProps {
    children?: React.ReactNode;
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    modal?: boolean;
  }
  export const Popover: React.FC<PopoverProps>;
  export interface PopoverTriggerProps extends React.ComponentProps<"button"> {
    asChild?: boolean;
  }
  export const PopoverTrigger: React.FC<PopoverTriggerProps>;
  export interface PopoverContentProps extends React.ComponentProps<"div"> {
    align?: "start" | "center" | "end";
    side?: "top" | "right" | "bottom" | "left";
    sideOffset?: number;
    alignOffset?: number;
  }
  export const PopoverContent: React.FC<PopoverContentProps>;
  export const PopoverAnchor: React.FC<React.ComponentProps<"div">>;
}

// Radio Group
declare module "@/components/ui/radio-group" {
  import type * as React from "react";
  export interface RadioGroupProps {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    name?: string;
    required?: boolean;
    orientation?: "horizontal" | "vertical";
    dir?: "ltr" | "rtl";
    loop?: boolean;
    className?: string;
    children?: React.ReactNode;
  }
  export const RadioGroup: React.FC<RadioGroupProps>;
  export interface RadioGroupItemProps {
    value: string;
    id?: string;
    disabled?: boolean;
    required?: boolean;
    className?: string;
  }
  export const RadioGroupItem: React.FC<RadioGroupItemProps>;
}

// Select
declare module "@/components/ui/select" {
  import type * as React from "react";
  export interface SelectProps {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    dir?: "ltr" | "rtl";
    name?: string;
    disabled?: boolean;
    required?: boolean;
    children?: React.ReactNode;
  }
  export const Select: React.FC<SelectProps>;
  export interface SelectTriggerProps extends React.ComponentProps<"button"> {
    size?: "sm" | "default";
  }
  export const SelectTrigger: React.FC<SelectTriggerProps>;
  export interface SelectValueProps {
    placeholder?: React.ReactNode;
  }
  export const SelectValue: React.FC<SelectValueProps>;
  export interface SelectContentProps extends React.ComponentProps<"div"> {
    position?: "item-aligned" | "popper";
    align?: "start" | "center" | "end";
    side?: "top" | "right" | "bottom" | "left";
    sideOffset?: number;
  }
  export const SelectContent: React.FC<SelectContentProps>;
  export interface SelectItemProps extends React.ComponentProps<"div"> {
    value: string;
    disabled?: boolean;
    textValue?: string;
  }
  export const SelectItem: React.FC<SelectItemProps>;
}

// Slider
declare module "@/components/ui/slider" {
  import type * as React from "react";
  export interface SliderProps {
    value?: number[];
    defaultValue?: number[];
    onValueChange?: (value: number[]) => void;
    onValueCommit?: (value: number[]) => void;
    min?: number;
    max?: number;
    step?: number;
    minStepsBetweenThumbs?: number;
    orientation?: "horizontal" | "vertical";
    disabled?: boolean;
    inverted?: boolean;
    className?: string;
    id?: string;
    name?: string;
  }
  export const Slider: React.FC<SliderProps>;
}

// Switch
declare module "@/components/ui/switch" {
  import type * as React from "react";
  export interface SwitchProps {
    checked?: boolean;
    defaultChecked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    disabled?: boolean;
    required?: boolean;
    name?: string;
    value?: string;
    id?: string;
    className?: string;
  }
  export const Switch: React.FC<SwitchProps>;
}

// Tabs
declare module "@/components/ui/tabs" {
  import type * as React from "react";
  export interface TabsProps {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    orientation?: "horizontal" | "vertical";
    dir?: "ltr" | "rtl";
    activationMode?: "automatic" | "manual";
    className?: string;
    children?: React.ReactNode;
  }
  export const Tabs: React.FC<TabsProps>;
  export const TabsList: React.FC<React.ComponentProps<"div">>;
  export interface TabsTriggerProps extends React.ComponentProps<"button"> {
    value: string;
    disabled?: boolean;
  }
  export const TabsTrigger: React.FC<TabsTriggerProps>;
  export interface TabsContentProps extends React.ComponentProps<"div"> {
    value: string;
    forceMount?: boolean;
  }
  export const TabsContent: React.FC<TabsContentProps>;
}

// Textarea
declare module "@/components/ui/textarea" {
  import type * as React from "react";
  export const Textarea: React.FC<React.ComponentProps<"textarea">>;
}

// Utils
declare module "@/lib/utils" {
  export function cn(
    ...inputs: (string | undefined | null | false | Record<string, boolean>)[]
  ): string;
}
