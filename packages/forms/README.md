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

- pagination submissions/forms lists
  - Currently we always filter by formId for submissions, as we sort by a different column we need a
    composite index on formId and submittedAt. This needs Multi-cursor pagination which is not yet
    supported.

## TODO

- Improved UX for server side form validation
  - See if zod "fromJsonSchema" is nice for this
- Interactive form builder (use AI for now :thumbsup:)
- Aggregated form submission results
- CSV/Excel/Sheets exports
- File Uploads (another fragment maybe?)
- Editable submissions
- Multiple and single response type forms
- Tying external entities to form submissions
