# JSONForms ShadCN Renderer

## Install

```npm
pnpm add @fragno-dev/jsonforms-shadcn-renderers
```

Make sure you have all of these shadcn components added to your project:

```bash
pnpm dlx shadcn@latest add button \
        calendar \
        card \
        checkbox \
        field \
        input \
        label \
        popover \
        radio-group \
        select \
        slider \
        switch \
        tabs \
        textarea
```

## Configure

### Vite:

Because you need to bring your own ShadCN components, these imports must be resolvable in Vite.

If you get this error, it means vite cannot find your components.

```
[vite] Internal server error: Failed to resolve import "@/components/ui/slider" from "jsonforms-shadcn-renderers/src/shadcn-controls/ShadcnSlider.tsx". Does the file exist?
```

```ts
import { defineConfig } from "vite";
import path from "path";

const config = defineConfig({
  resolve: {
    alias: {
      "@/components": path.resolve(__dirname, "./src/components"),
      "@/lib": path.resolve(__dirname, "./src/lib"),
    },
  },
});

export default config;
```

### Tailwind

Be sure to include this library as a tailwind source, otherwise it will not include the classes used
in your final build!

https://tailwindcss.com/docs/detecting-classes-in-source-files#explicitly-registering-sources

```css
@source "../node_modules/@fragno-dev/jsonforms-shadcn-renderers";
```

## Usage

```ts
import { JsonForms } from "@jsonforms/react";
import {
  shadcnRenderers,
  shadcnCells,
} from "@fragno-dev/jsonforms-shadcn-renderers";

function MyDynamicForm() {
  return (
    <JsonForms
      schema={schema}
      uischema={uiSchema}
      data={data}
      renderers={shadcnRenderers}
      cells={shadcnCells}
      onChange={({ data }) => setData(data)}
    />
  );
}
```

## Features

### Controls

| Feature                   | Shadcn                     | Status |
| ------------------------- | -------------------------- | ------ |
| Boolean (checkbox)        | ShadcnBooleanControl       | ✅     |
| Boolean (toggle/switch)   | ShadcnBooleanToggleControl | ✅     |
| Text                      | ShadcnTextControl          | ✅     |
| Textarea (multi-line)     | ShadcnTextAreaControl      | ✅     |
| Integer                   | ShadcnIntegerControl       | ✅     |
| Number                    | ShadcnNumberControl        | ✅     |
| Slider                    | ShadcnSliderControl        | ✅     |
| Date                      | ShadcnDateControl          | ✅     |
| Time                      | ShadcnTimeControl          | ✅     |
| DateTime                  | ShadcnDateTimeControl      | ✅     |
| Enum (select)             | ShadcnEnumControl          | ✅     |
| Enum (radio)              | ShadcnEnumRadioControl     | ✅     |
| OneOf Enum (select)       | ShadcnOneOfEnumControl     | ✅     |
| OneOf Enum (radio)        | -                          | ❌     |
| Object (nested)           | ShadcnObjectControl        | ✅     |
| Array (table)             | -                          | ❌     |
| Array (expandable panels) | -                          | ❌     |
| AllOf                     | -                          | ❌     |
| AnyOf                     | -                          | ❌     |
| OneOf (polymorphic)       | -                          | ❌     |
| Enum Array (multi-select) | -                          | ❌     |
| AnyOf String/Enum         | -                          | ❌     |
| Native inputs             | -                          | ❌     |

### Layouts

| Feature                  | Shadcn                            | Status |
| ------------------------ | --------------------------------- | ------ |
| Vertical                 | ShadcnVerticalLayout              | ✅     |
| Horizontal               | ShadcnHorizontalLayout            | ✅     |
| Group                    | ShadcnGroupLayout                 | ✅     |
| Categorization (tabs)    | ShadcnCategorizationLayout        | ✅     |
| Categorization (stepper) | ShadcnCategorizationStepperLayout | ✅     |
| Array Layout             | -                                 | ❌     |

### Additional Renderers

| Feature        | Shadcn | Status |
| -------------- | ------ | ------ |
| Label          | -      | ❌     |
| ListWithDetail | -      | ❌     |

### Cells (for tables/arrays)

| Feature        | Shadcn                  | Status |
| -------------- | ----------------------- | ------ |
| Boolean        | ShadcnBooleanCell       | ✅     |
| Boolean Toggle | ShadcnBooleanToggleCell | ✅     |
| Text           | ShadcnTextCell          | ✅     |
| Integer        | ShadcnIntegerCell       | ✅     |
| Number         | ShadcnNumberCell        | ✅     |
| Number Format  | -                       | ❌     |
| Date           | ShadcnDateCell          | ✅     |
| Time           | ShadcnTimeCell          | ✅     |
| DateTime       | ShadcnDateTimeCell      | ✅     |
| Enum           | ShadcnEnumCell          | ✅     |
| Enum Radio     | ShadcnEnumRadioCell     | ✅     |
| OneOf Enum     | ShadcnOneOfEnumCell     | ✅     |
| Slider         | ShadcnSliderCell        | ✅     |
