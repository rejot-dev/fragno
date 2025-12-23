# JSONForms ShadCN Renderer

## Install

```npm
pnpm add @fragno-dev/jsonforms-shadcn-renderers \
         @jsonforms/react
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
  ssr: {
    noExternal: ["@fragno-dev/jsonforms-shadcn-renderers"],
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

## Compatibility

See [this page on our docs](https://fragno.dev/docs/forms/shadcn-renderer#supported-features) for
all JSONforms primitives we support.
