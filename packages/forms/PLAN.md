# Forms Fragment Implementation Plan

## Overview

Build a full-stack forms fragment following the Form/Block/Atom hierarchy described in
`forms-explained.md`. This fragment will enable users to create, manage, and collect responses for
form-based surveys and data collection.

## Scope Decisions

- **Authentication**: Optional `onAuth` callback in config for flexibility
- **Atom Types (Phase 1)**: Minimal 3 types - `openText`, `multipleChoiceSingle`, `rating`
- **In-App SDK**: Deferred - focus on link-based forms first
- **i18n**: Full I18nString support with language configuration from the start

## Architecture Summary

```
Form (top-level container)
├── Welcome Card (optional intro)
├── Blocks[] (navigation containers)
│   └── Atoms[] (form fields: openText, multipleChoiceSingle, rating)
├── Endings[] (completion screens)
├── Variables[] (calculated values)
└── Hidden Fields (pre-populated data)
```

---

## Phase 1: Project Setup & Schema Definition

### 1.1 Initialize Package Structure

Create the forms package with standard fragment structure:

```
packages/forms/
├── src/
│   ├── index.ts                 # Main fragment definition
│   ├── schema.ts                # Database schema
│   ├── server/
│   │   ├── routes/
│   │   │   ├── management.ts    # Admin CRUD routes
│   │   │   └── client.ts        # Public submission routes
│   │   ├── services/
│   │   │   ├── form-service.ts
│   │   │   └── response-service.ts
│   │   └── validation/
│   │       ├── atom-schemas.ts  # Zod schemas for each atom type
│   │       └── form-schemas.ts  # Form/Block validation
│   └── client/
│       ├── react.ts
│       ├── vue.ts
│       ├── svelte.ts
│       └── vanilla.ts
├── package.json
├── tsdown.config.ts
└── tsconfig.json
```

### 1.2 Define Database Schema

**File: `src/schema.ts`**

Tables needed (per forms-explained.md):

- `form` - Main form entity
- `response` - User submissions
- `display` - Tracking when forms are shown
- `form_trigger` - Action event links (for in-app forms)
- `form_language` - Multi-language support junction
- `form_quota` - Response limits with conditional logic

Key schema patterns:

- Use `idColumn()` for external CUID IDs
- Use `column("json")` for complex nested structures (blocks, atoms, endings, variables)
- Create indexes on `environmentId`, `formId`, `contactId` for efficient queries

---

## Phase 2: Zod Schemas for Validation

### 2.1 Base Atom Schema

Define common properties all atoms share:

- `id`, `type`, `headline`, `subheader`, `imageUrl`, `videoUrl`, `required`, `isDraft`

### 2.2 Individual Atom Type Schemas (Phase 1: 3 Types)

Create discriminated union schemas for initial atom types:

**1. `openText`** - Free-form text input

- `placeholder: I18nString` - Hint text
- `longAnswer: boolean` - Multi-line textarea
- `inputType: "text" | "email" | "url" | "number" | "phone"`
- `charLimit: { enabled: boolean, min?: number, max?: number }`

**2. `multipleChoiceSingle`** - Radio button selection

- `choices: { id: string, label: I18nString }[]`
- `shuffleOption: "none" | "all" | "exceptLast"`
- `otherOptionPlaceholder?: I18nString` - Write-in option

**3. `rating`** - Star/smiley/number scale

- `scale: "number" | "smiley" | "star"`
- `range: 3 | 4 | 5 | 6 | 7 | 10`
- `lowerLabel?: I18nString`
- `upperLabel?: I18nString`
- `isColorCodingEnabled?: boolean`

**Future Atom Types** (to be added incrementally):

- multipleChoiceMulti, cta, consent, date, pictureSelection, address, contactInfo, ranking

### 2.3 Block Schema

- `id`, `name`, `atoms[]`, `logic[]`, `logicFallback`, `buttonLabel`, `backButtonLabel`

### 2.4 Form Schema

Complete form validation with all fields from forms-explained.md

---

## Phase 3: Fragment Definition

### 3.1 Core Fragment Setup

**File: `src/index.ts`**

```typescript
interface FormsConfig {
  // Optional auth callback - returns true if authorized, false otherwise
  onAuth?: (request: Request) => Promise<boolean> | boolean;

  // Optional callbacks for events
  onFormCreated?: (form: Form) => void;
  onResponseSubmitted?: (response: Response) => void;
}
```

Use `defineFragment().extend(withDatabase(schema))` pattern.

**Auth Pattern in Routes:**

```typescript
handler: async function({ request }, { json, error }) {
  if (config.onAuth && !(await config.onAuth(request))) {
    return error({ message: "Unauthorized", code: "UNAUTHORIZED" }, 401);
  }
  // ... rest of handler
}
```

### 3.2 Services

**FormService:**

- `createForm(data)` - Create new form
- `getForm(id)` - Get form by ID
- `updateForm(id, data)` - Update form
- `deleteForm(id)` - Delete form
- `listForms(environmentId, pagination)` - List forms with pagination
- `validateFormLogic(form)` - Check for cyclic logic

**ResponseService:**

- `createResponse(formId, data)` - Submit response
- `updateResponse(id, data)` - Update in-progress response
- `getResponse(id)` - Get response by ID
- `listResponses(formId, filters)` - List responses with filtering

---

## Phase 4: Route Definitions

### 4.1 Management API Routes (Authenticated)

**Forms:**

- `POST /management/forms` - Create form
- `GET /management/forms` - List forms (with pagination)
- `GET /management/forms/:id` - Get single form
- `PUT /management/forms/:id` - Update form
- `DELETE /management/forms/:id` - Delete form

**Responses:**

- `POST /management/responses` - Admin import response
- `GET /management/responses` - List responses (with filtering)
- `GET /management/responses/:id` - Get single response
- `PUT /management/responses/:id` - Update response
- `DELETE /management/responses/:id` - Delete response

### 4.2 Client API Routes (Public)

**Form Retrieval (for link-based forms):**

- `GET /client/:environmentId/forms/:formId` - Get form for rendering

**Response Submission:**

- `POST /client/:environmentId/responses` - Submit new response
- `PUT /client/:environmentId/responses/:id` - Update in-progress response

**Deferred (In-App SDK - Future Phase):**

- Form sync, triggers, display tracking to be added later

---

## Phase 5: Client Builder

### 5.1 Client Hooks

Create type-safe hooks for both management and client APIs:

**Management Hooks:**

- `useForms()` - List forms
- `useForm(id)` - Get single form
- `useCreateForm()` - Mutation for creating forms
- `useUpdateForm()` - Mutation for updating forms
- `useDeleteForm()` - Mutation for deleting forms
- `useResponses(formId)` - List responses
- `useResponse(id)` - Get single response

**Client Hooks (Public Form Rendering):**

- `usePublicForm(formId)` - Get form for rendering
- `useSubmitResponse()` - Submit form response
- `useUpdateResponse()` - Update in-progress response

### 5.2 Framework Wrappers

Create standard wrappers for React, Vue, Svelte, Solid, Vanilla.

---

## Phase 6: Validation & Logic

### 6.1 Form Validation

- Validate atom IDs are unique within blocks
- Validate required labels exist for all enabled languages
- Check for cyclic logic in block navigation
- Validate atom-specific rules (charLimit, choice counts, etc.)

### 6.2 Response Validation

- Validate required fields have values
- Type-check response values against atom types
- Validate quota limits haven't been exceeded

---

## Phase 7: Build & Export Configuration

### 7.1 Package.json Exports

```json
{
  "exports": {
    ".": {
      /* server entry */
    },
    "./react": {
      /* React client */
    },
    "./vue": {
      /* Vue client */
    },
    "./svelte": {
      /* Svelte client */
    },
    "./vanilla": {
      /* Vanilla client */
    }
  }
}
```

### 7.2 TSDown Config

Configure dual browser/node builds with unplugin-fragno code splitting.

---

## Phase 8: Testing

### 8.1 Unit Tests

- Schema validation tests
- Service logic tests
- Route handler tests

### 8.2 Integration Tests

- Full form CRUD workflow
- Response submission flow
- Logic validation (cyclic detection)

---

## Implementation Order

1. **Setup** - Package structure, dependencies, tsconfig
2. **Schema** - Database schema definition
3. **Validation** - Zod schemas for atoms, blocks, forms
4. **Fragment** - Core fragment with withDatabase
5. **Services** - FormService, ResponseService
6. **Routes** - Management API, then Client API
7. **Client** - Client builder and framework wrappers
8. **Tests** - Unit and integration tests
9. **Build** - Package.json exports, tsdown config

---

## Critical Files to Reference

- `example-fragments/chatno/src/index.ts` - Fragment definition pattern
- `example-fragments/chatno/package.json` - Export structure
- `packages/fragno-db/src/schema/create.ts` - Schema builder API
- `packages/fragno/src/api/route.ts` - Route definition patterns
- `packages/forms/forms-explained.md` - Source of truth for data model

---

## Verification Checkpoints

Throughout implementation, verify against `forms-explained.md`:

1. **After Schema Definition**: Ensure all Form model fields are represented
2. **After Atom Schemas**: Verify base properties match specification
3. **After Block Schema**: Confirm logic and navigation fields are correct
4. **After Response Schema**: Check response data structure matches spec
5. **After i18n Implementation**: Verify I18nString pattern is consistent
