# @fragno-dev/forms

A [Fragno](https://fragno.dev/) fragment for building dynamic forms using
[JSON Forms](https://jsonforms.io/).

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

## Issues

- slugs
- pagination submissions/forms lists

## TODO

- Pre-population of fields
- Improved UX for server side form validation
- Interactive form builder (use AI for now :thumbsup:)
- Aggregated form submission results
- CSV/Excel/Sheets exports
- File Uploads (another fragment maybe?)
- Static-forms (forms defined in code)
- Editable submissions
- Multiple and single response
