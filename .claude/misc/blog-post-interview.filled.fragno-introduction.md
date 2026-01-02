# Filled blog post interview — `fragno-introduction.mdx`

Source: `apps/docs/content/blog/fragno-introduction.mdx`

## 1) One-liner (thesis + promise)

- **What’s the working title?** The case for full-stack libraries
- **In one sentence: what will the reader believe/do differently after reading?** Libraries are
  better when they span frontend + backend (and eventually database), and Fragno provides primitives
  to build and integrate such full-stack libraries across frameworks.
- **What’s the “unexpected” claim / contrarian angle (if any)?** The “missing” unit of reuse isn’t
  another frontend or backend library; it’s a _full-stack_ library that ships its own routes +
  client interface (so users don’t write glue code).
- **What’s the single most important takeaway (if they remember only one thing)?** Ship full-stack
  integration primitives (routes + client API) to remove glue code; Fragno is a framework-agnostic
  way to do that in TypeScript.

## 2) Reader + context (avoid the curse of knowledge)

- **Who is the exact reader?** Implied: TypeScript library authors building integrations that span
  frontend + backend; also app developers evaluating the approach.
- **What do they already know?** Implied: modern JS/TS frameworks, HTTP request/response, basic API
  route concepts, client-side hooks/reactivity.
- **What do they _not_ know yet (but need)?** The concept of “full-stack libraries” as a reusable
  unit, and how Fragno models routes + typed hooks + framework integration.
- **What environment constraints matter?** Multiple frontend/backend frameworks; common denominator
  is HTTP `Request`/`Response`; client-side reactivity across frameworks (React/Vue/Svelte/Solid,
  etc.).
- **What prerequisites should be explicitly listed at the top?** Not specified.
- **What is explicitly out of scope?** Implied by “Lots of details omitted for brevity”: full,
  end-to-end code and all API details; also database integration and SSR are discussed as
  future/missing.

## 3) The hook (why they should care _now_)

- **What problem pain feels familiar to the reader?** Using a library still forces you to write lots
  of glue: routes, OpenAPI/docs, client integration, wiring, and duplicated patterns per project.
- **What’s a concrete failure mode / “ugh moment” you’ve seen in the wild?** AI/LLM chatbot: backend
  holds keys and function calling, frontend is the UX; using `openai` only covers backend so you
  still must implement routes, comms, function calling, streaming, etc.
- **What’s the cost of the status quo?** Re-implementation per project; custom wiring across layers;
  more effort than “using a library” suggests; inconsistent integrations.
- **What story can you open with (1–2 paragraphs) that makes the problem real?** “I was working on
  an AI chatbot and realized I needed a full-stack library, but there was no good solution because
  of the many frontend/backend frameworks.”
- **What’s the smallest example that demonstrates the pain in <60 seconds?** The AI chatbot
  integration example (frontend chat UI + backend keys/function calling + optional streaming)
  illustrates immediate split responsibilities and glue.

## 4) The “before” picture (current approach)

- **How is this typically solved today?** Libraries are frontend-only or backend-only; users
  implement the missing half and the glue: routes, communication, docs, and integration.
- **What glue code usually appears, and why?** API routes + request validation + error handling +
  streaming support; client-side data fetching + caching/invalidation; framework-specific
  integration shims.
- **Where does complexity hide?** Cross-framework differences; “expectations are high” for routes
  (type safety, validation, error handling, content types, streaming); reactivity and data fetching
  patterns on the client.
- **What do people routinely get wrong?** Not specified.
- **What trade-offs are they (unknowingly) accepting?** Higher integration cost and repetition;
  tighter coupling to a specific stack; less portable solutions.

## 5) The core idea (the concept you’re teaching)

- **What’s the core concept in neutral terms (no Fragno yet)?** A “full-stack library” should ship
  both server-side integration (routes/handlers) and client-side integration (typed
  interface/hooks), with a minimal integration surface so it can work across frameworks.
- **What are the key terms that must be defined on first use?** Full-stack library; “glue code”;
  routes; hooks; reactivity; TanStack Query-style data fetching; code splitting; middleware (in
  Fragno’s sense).
- **What mental model should the reader adopt?** Library provides portable primitives for both sides
  of the stack; users mount server routes and consume a client interface similarly to TanStack
  Query.
- **What are the 2–4 sub-ideas that build up to the main idea (in teaching order)?**
  - Defining server-side routes in a framework-agnostic way (via HTTP `Request`/`Response`)
  - Defining a client-side interface via reactive hooks/stores (TanStack Query-like)
  - Keeping user integration simple (mount routes + use framework adapter)
  - Making it practical: type safety + automatic code splitting
- **What is the “worked example” you’ll use throughout?** A todo-like example route (`GET /todos`)
  plus client hooks (`useTodos`, `useAddTodo`).

## 6) The solution (what you’re proposing)

- **What is the proposed approach at a high level?** Provide primitives for library authors to
  define routes + client interface once, then integrate into many frameworks with small adapters.
- **What are the components of the approach?**
  - Backend: route definitions mounted into the user’s app
  - Frontend: reactive hooks/stores for fetching/mutations
  - Build step: code splitting of server-only code from client bundles
  - Integration: framework-specific `useFragno` + backend mounting shims
  - Server-side extensibility: middleware (user-defined), config/dependencies/services
- **What are the key design constraints you respected?** Framework-agnostic; type-safe; good DX; low
  friction for end users; common-denominator abstractions.
- **What are the non-goals / consciously rejected features?** Not specified.
- **What does success look like?** Library users integrate with “a few lines of code”; library
  authors ship higher-level full-stack building blocks that work across frameworks.

## 7) “Why Fragno” (tie the idea to Fragno without making it an ad)

- **Which Fragno idea does this post exemplify?** Fragments (full-stack libraries), route
  definition, client builder + hooks, adapters for many frameworks, code splitting via
  `@fragno-dev/unplugin-fragno`, middleware, config/dependencies/services.
- **What does Fragno make _possible_ that’s hard otherwise?** A single canonical definition that
  generates server + client artifacts with end-to-end types, while still shipping as a library
  usable across many frameworks.
- **What does Fragno make _simpler_ (and for whom: library author vs user)?**
  - Library author: define routes + client interface once; get type safety + splitting.
  - User: mount routes and use hooks in their framework without re-implementing glue.
- **Where does Fragno intentionally _not_ take over?** User-defined middleware and app-specific
  concerns; library authors can skip the client builder and use Nanostores directly for custom
  stores.
- **What’s the minimal snippet that shows the Fragno “shape” of the solution?**
  - `defineRoute({ method, path, schemas, handler })` for the server
  - `createClientBuilder(...).createHook("/todos")` for the client
- **If the reader never uses Fragno, what idea should they still steal?** Treat integrations as
  full-stack building blocks: ship server handlers + a client interface together, and design for
  minimal, portable integration surfaces.

## 8) Evidence + credibility (show, don’t assert)

- **What concrete artifacts can you include?** Code examples for route definition and client
  builder; framework mounting snippets via includes; a diagram/metaphor (cake/fragment).
- **What results can you quantify?** Not specified (qualitative claim: “a few lines of code” and
  reduced glue).
- **What trade-offs did you encounter and how did you choose?** Choose HTTP `Request`/`Response` as
  common denominator; choose Nanostores + Nanostores Query to align with TanStack Query-style
  ergonomics.
- **What’s the “gotcha” section?** Implied: code splitting is required for library authors; ensuring
  server-only code doesn’t leak to client bundles.
- **What’s the migration story from the status quo?** Implied: adopt Fragno by defining routes +
  client interface, then integrate into your framework via the provided adapters; detailed
  walkthroughs are linked (quick starts).

## 9) Structure choice (deep dive vs tutorial)

- **Is this a “Problem → Solution → Trade-offs” post or a step-by-step tutorial?** Problem → goals →
  solution overview → under-the-hood → what’s missing → conclusion.
- If tutorial: **What are the steps, and how does the reader verify each step worked?** Not a
  step-by-step tutorial; verification steps are not specified.
- If deep dive: **What’s the narrative arc?**
  - Setup: libraries create glue code gaps across frontend/backend
  - Confrontation: many frameworks make full-stack libraries hard
  - Resolution: Fragno primitives + adapters + code splitting make it workable
- **What sections are “scan-friendly” anchors?** Related work; Goals; Defining server-side API
  routes; Frontend state management; Integration simplicity; Under the hood; What’s missing;
  Conclusion.
- **Where will you place diagrams to reduce cognitive load?** The post uses a visual “cake” metaphor
  figure near the end; earlier sections rely on code snippets.

## 10) Reader outcomes (what they can do after)

- **What can the reader copy/paste and run?** Example `defineRoute` and `createClient` patterns (not
  fully runnable as-is; details omitted).
- **What can the reader adapt to their own stack?** The integration approach: mount routes + use
  framework adapter; apply the “full-stack library” concept to their domain.
- **What checklist/heuristics can they reuse in future decisions?** When evaluating an
  integration/library, ask “what glue code am I still writing?” and “could this be shipped as
  full-stack primitives?”
- **What are 3 crisp takeaways you’ll restate near the end?**
  - Ship routes + a client interface as a library.
  - Keep the integration surface tiny and framework-agnostic.
  - Use code splitting + a single canonical definition to keep types aligned.

## 11) Call to action (helpful next step, not pushy)

- **What should the reader do next in 5 minutes?** Read the quick starts and try integrating a
  fragment.
- **Which Fragno doc/page should you link as the “next step”?**
  - Library Quick Start: `/docs/fragno/for-library-authors/getting-started`
  - User Quick Start: `/docs/user-quick-start`
  - Framework Support: `/docs/frameworks`
- **What feedback are you asking for (specific questions)?** “Any feedback is more than welcome!”
  (not more specific).
- **What’s the “try it yourself” path (repo/example/quickstart)?** Star the GitHub repo; follow
  quick starts.

## 12) Packaging (title/summary/SEO without losing soul)

- **What’s the 1–2 sentence description (meta) that sets expectations?** “Why software libraries are
  better when they span both the frontend and the backend, and how Fragno helps you build full-stack
  libraries.”
- **What search query should this post win?** Implied: “full-stack libraries”, “framework-agnostic
  full-stack TypeScript library”, “build full-stack SDK”.
- **What terms should appear in headings?** Full-stack libraries; API routes; client-side state
  management; integration; type safety; code splitting; middleware.
- **What’s the one hero diagram/figure that could be shared standalone?** The cake metaphor figure:
  fragment as a cake slice; user’s app as the full cake.
