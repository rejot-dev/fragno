# @fragno-dev/forms

A [Fragno](https://fragno.dev/) fragment for building dynamic forms using [JSON Forms](https://jsonforms.io/).

## Installation

```bash
npm install @fragno-dev/forms
```

## Usage

### Server Setup

```typescript
import { createFormsFragment } from "@fragno-dev/forms";

const forms = createFormsFragment(
  {
    onFormCreated: (form) => console.log("Form created:", form.title),
    onResponseSubmitted: (response) => console.log("Response submitted:", response.id),
  },
  {
    databaseAdapter: yourDatabaseAdapter,
  },
);
```
## TODO

- Pre-population of fields
- Anonymous form submissions
- Improved UX for server side form validation
- Provide shadcn/tailwindcss rendering options
- Interactive form builder (use AI for now :thumbsup:)
- Aggregated form submission results
- CSV/Excel/Sheets exports
- File Uploads (another fragment maybe?)
- Multi-step forms
- Static-forms (forms defined in code)
- Editable submissions
- Multi/Single response
