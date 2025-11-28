# Form Fragment - Core Components

This document provides a conceptual analysis of the core of a form-building fragment.

## Architecture Overview

forms uses a **Form/Block/Atom** hierarchy:

- **Form**: The top-level container that holds all form configuration
- **Blocks**: Containers that group one or more form atoms together, managing navigation flow
  between sections
- **Atoms**: The actual form fields (text inputs, multiple choice, ratings, etc.)

A form also contains:

- **Welcome Card**: An optional intro screen shown before questions
- **Endings**: Completion screens (thank you messages or redirects)
- **Variables**: Values that can be calculated and piped throughout the form
- **Hidden Fields**: Pre-populated data passed via URL or SDK

---

## Database Schema

### Form Model

The Form is the main entity containing all form configuration. Key fields:

| Field                           | Type       | Description                                                        |
| ------------------------------- | ---------- | ------------------------------------------------------------------ |
| id                              | CUID       | Unique identifier                                                  |
| name                            | String     | Display name                                                       |
| type                            | Enum       | "link" (shareable URL) or "app" (embedded in-app)                  |
| status                          | Enum       | "draft", "inProgress", "paused", "completed"                       |
| environmentId                   | String     | Reference to environment/workspace                                 |
| welcomeCard                     | JSON       | Optional intro screen configuration                                |
| blocks                          | JSON Array | Array of block objects containing form atoms                       |
| endings                         | JSON Array | Completion screens or redirect configurations                      |
| hiddenFields                    | JSON       | Configuration for pre-populated hidden data                        |
| variables                       | JSON Array | Calculation variables for piping/logic                             |
| displayOption                   | Enum       | "displayOnce", "displayMultiple", "displaySome", "respondMultiple" |
| displayLimit                    | Integer    | Max times to show (when displayOption is "displaySome")            |
| recontactDays                   | Integer    | Days before reshowing to same user                                 |
| delay                           | Integer    | Milliseconds to wait before showing                                |
| autoClose                       | Integer    | Auto-close after N seconds of inactivity                           |
| autoComplete                    | Integer    | Auto-mark complete after N responses                               |
| styling                         | JSON       | Visual customization (colors, fonts, etc.)                         |
| singleUse                       | JSON       | Single-use link configuration                                      |
| isVerifyEmailEnabled            | Boolean    | Require email verification                                         |
| isSingleResponsePerEmailEnabled | Boolean    | One response per email                                             |
| isBackButtonHidden              | Boolean    | Hide back navigation                                               |
| pin                             | String     | Optional PIN protection                                            |
| metadata                        | JSON       | SEO metadata for link forms                                        |

### Response Model

Stores user submissions for a form:

| Field             | Type              | Description                                    |
| ----------------- | ----------------- | ---------------------------------------------- |
| id                | CUID              | Unique identifier                              |
| formId            | String            | Reference to parent form                       |
| contactId         | String (optional) | Reference to known user                        |
| finished          | Boolean           | Whether form was completed                     |
| endingId          | String (optional) | Which ending card was reached                  |
| data              | JSON              | Key-value map of atom ID to response value     |
| variables         | JSON              | Final calculated variable values               |
| meta              | JSON              | Browser, device, location, referrer info       |
| contactAttributes | JSON              | Snapshot of user attributes at submission time |
| singleUseId       | String (optional) | For single-use link tracking                   |
| language          | String (optional) | Language code used for response                |
| displayId         | String (optional) | Reference to display tracking record           |

### Supporting Models

**FormTrigger**: Links forms to action events (for in-app forms). When a user performs a tracked
action, forms with matching triggers are shown.

**FormLanguage**: Junction table linking forms to enabled languages, with a "default" flag for the
primary language.

**FormQuota**: Defines response limits with conditional logic. When quotas are met, forms can end or
redirect to specific endings.

---

## Form Field Types (Atoms)

Atoms are the individual form fields users interact with. All atoms share common base properties,
then have type-specific fields.

### Base Atom Properties

All atoms have these common fields:

| Property  | Type                  | Description                                            |
| --------- | --------------------- | ------------------------------------------------------ |
| id        | String                | Unique identifier (alphanumeric, hyphens, underscores) |
| type      | Enum                  | The atom type (see below)                              |
| headline  | I18nString            | Main question/prompt text                              |
| subheader | I18nString (optional) | Additional description text                            |
| imageUrl  | URL (optional)        | Header image                                           |
| videoUrl  | URL (optional)        | Header video                                           |
| required  | Boolean               | Whether an answer is mandatory                         |
| isDraft   | Boolean (optional)    | Editor draft state flag                                |

### Atom Types

#### 1. Open Text (openText)

Free-form text input with optional validation.

Additional properties:

- **placeholder**: Hint text shown in empty field
- **longAnswer**: If true, renders as multi-line textarea
- **inputType**: "text", "email", "url", "number", or "phone" - affects keyboard on mobile and
  validation
- **charLimit**: Object with enabled flag, min, and max character counts
- **insightsEnabled**: Whether to analyze responses with AI

#### 2. Multiple Choice Single (multipleChoiceSingle)

Radio button selection - user picks exactly one option.

Additional properties:

- **choices**: Array of choice objects with id and label
- **shuffleOption**: "none", "all", or "exceptLast" - randomizes choice order
- **otherOptionPlaceholder**: If present, adds an "other" write-in option

#### 3. Multiple Choice Multi (multipleChoiceMulti)

Checkbox selection - user can pick multiple options.

Same additional properties as Multiple Choice Single.

#### 5. Rating (rating)

Star rating, smiley faces, or numeric scale.

Additional properties:

- **scale**: "number", "smiley", or "star" - visual style
- **range**: 3, 4, 5, 6, 7, or 10 - number of options
- **lowerLabel**: Text for lowest rating
- **upperLabel**: Text for highest rating
- **isColorCodingEnabled**: Color gradient across scale

#### 6. CTA (cta)

Call-to-action button - typically used for intermediate actions or external links.

Additional properties:

- **buttonExternal**: If true, button opens external URL
- **buttonUrl**: The URL to open (required if buttonExternal is true)
- **ctaButtonLabel**: Custom button text

#### 7. Consent (consent)

Single checkbox for terms acceptance, privacy policy, etc.

Additional properties:

- **label**: The checkbox label text (supports HTML)

#### 8. Date (date)

Date picker input.

Additional properties:

- **format**: "M-d-y", "d-M-y", or "y-M-d" - display format
- **html**: Additional description/instructions

#### 9. Picture Selection (pictureSelection)

Image-based choice selection.

Additional properties:

- **allowMulti**: If true, allows selecting multiple images
- **choices**: Array of choice objects with id and imageUrl

#### 12. Address (address)

Structured address input with configurable fields.

Additional properties (each is a toggle config object with show, required, placeholder):

- **addressLine1**, **addressLine2**, **city**, **state**, **zip**, **country**

#### 13. Contact Info (contactInfo)

Contact details collection with configurable fields.

Additional properties (each is a toggle config object):

- **firstName**, **lastName**, **email**, **phone**, **company**

#### 14. Ranking (ranking)

Drag-and-drop ordering of items.

Additional properties:

- **choices**: Array of items to rank (2-25 items)
- **shuffleOption**: Initial randomization
- **otherOptionPlaceholder**: Optional write-in item

---

## Block System

Blocks are containers that group atoms together and manage navigation flow between form sections.

### Block Properties

| Property        | Type                  | Description                                           |
| --------------- | --------------------- | ----------------------------------------------------- |
| id              | CUID                  | System-generated unique identifier                    |
| name            | String                | Display name for the block (required, used in editor) |
| atoms           | Array                 | One or more atoms in this block                       |
| logic           | Array (optional)      | Conditional logic rules                               |
| logicFallback   | Block ID (optional)   | Default next block if no logic conditions match       |
| buttonLabel     | I18nString (optional) | Custom "Next" button text                             |
| backButtonLabel | I18nString (optional) | Custom "Back" button text                             |

### Block Navigation

By default, blocks flow sequentially (Block 1 → Block 2 → Block 3 → Endings). Logic rules can
override this to skip blocks, loop back, or jump to specific destinations.

**Important constraint**: Atom IDs must be unique within a block.

---

## Validation System

### Atom ID Rules

Valid atom IDs must:

- Not contain spaces
- Only use alphanumeric characters, hyphens, or underscores
- Be unique within their block

### Multi-Language Label Validation

When a form has multiple languages enabled:

- All required labels must exist for each enabled language
- Empty HTML (like `<p><br></p>`) is treated as missing
- Validation strips HTML to check for actual text content

### Cyclic Logic Detection

The system validates that logic rules don't create infinite loops. A depth-first search algorithm
detects cycles where Block A → Block B → Block A would occur.

### Atom-Specific Validation

- **Open Text**: If charLimit is enabled, must have min or max value; min cannot exceed max
- **Multiple Choice**: Must have at least 2 choices
- **CTA**: If buttonExternal is true, buttonUrl is required and must be valid
- **Ranking**: Must have 2-25 choices
- **Picture Selection**: Must have at least 2 choices

---

## Response Handling

### Response Data Structure

Response data is stored as a flat key-value map where keys are atom IDs:

| Atom Type              | Response Value Format                         |
| ---------------------- | --------------------------------------------- |
| Open Text              | String                                        |
| Multiple Choice Single | String (selected choice ID)                   |
| Multiple Choice Multi  | Array of strings (selected choice IDs)        |
| Rating                 | Number                                        |
| CTA                    | String ("clicked" or "dismissed")             |
| Consent                | String ("accepted")                           |
| Date                   | String (formatted date)                       |
| Picture Selection      | String or array of strings (choice IDs)       |
| Matrix                 | Object mapping row ID to selected column ID   |
| Address                | Object with address component values          |
| Contact Info           | Object with contact field values              |
| Ranking                | Array of strings (choice IDs in ranked order) |

### Response Variables

Variables are calculated values that persist across the response. Stored as key-value pairs of
variable name to current value (string or number).

### Response Metadata

Captured automatically:

- **source**: Traffic source/referrer
- **url**: Page URL where form was taken
- **userAgent**: Browser, OS, and device info
- **country**: Geo-location (if available)
- **action**: The trigger action that showed the form (for in-app)

---

## Internationalization (i18n)

### I18nString Type

All user-facing text fields support multiple languages. An I18nString is an object where:

- Keys are language codes (e.g., "en", "de", "fr", "es")
- The "default" key is required and used as fallback
- Values are the translated text strings

Example conceptually:
`{ "default": "How are you?", "de": "Wie geht es Ihnen?", "fr": "Comment allez-vous?" }`

### Language Configuration

Each form has associated languages with:

- **language**: Reference to language definition (id, code, alias)
- **default**: Boolean indicating if this is the primary language
- **enabled**: Boolean indicating if this language is currently active

When rendering, the system:

1. Checks for text in the user's preferred language
2. Falls back to the default language if not found
3. Uses the "default" key value as final fallback

---

## API Structure

### Management API (authenticated, for admin operations)

**Forms:**

- `POST /forms/management/forms` - Create new form
- `GET /forms/management/forms` - List forms (supports limit/offset pagination)
- `GET /forms/management/forms/:id` - Get single form
- `PUT /forms/management/forms/:id` - Update form
- `DELETE /forms/management/forms/:id` - Delete form

**Responses:**

- `POST /forms/management/responses` - Create response (admin import)
- `GET /forms/management/responses` - List responses (supports filtering)
- `GET /forms/management/responses/:id` - Get single response
- `PUT /forms/management/responses/:id` - Update response
- `DELETE /forms/management/responses/:id` - Delete response

### Client API (public, for end-user submissions)

**Response Submission:**

- `POST /forms/client/:environmentId/responses` - Submit new response
- `PUT /forms/client/:environmentId/responses/:id` - Update in-progress response

**Form Sync (for in-app SDK):**

- `GET /forms/client/:environmentId/app/sync/:userId` - Get forms and state for user
- `GET /forms/client/:environmentId/environment` - Get environment configuration

**Display Tracking:**

- `POST /forms/client/:environmentId/displays` - Record that a form was shown

### Backward Compatibility Note

The API supports both legacy "questions" format (flat array of questions) and the newer "blocks"
format. When receiving questions, they're automatically converted to blocks (one atom per block).
When returning data, if all blocks have exactly one atom, they can be converted back to questions
format for older clients.
