# Blog post interview questionnaire (Fragno-adjacent)

Use this as a “Step 1” interview. Answer the questions (bullet answers are fine). Your answers
should be sufficient for drafting a full post outline and first draft that’s interesting _and_
subtly promotes Fragno by teaching ideas implemented in/around Fragno.

## 1) One-liner (thesis + promise)

- **What’s the working title?**
- **In one sentence: what will the reader believe/do differently after reading?**
- **What’s the “unexpected” claim / contrarian angle (if any)?**
- **What’s the single most important takeaway (if they remember only one thing)?**

## 2) Reader + context (avoid the curse of knowledge)

- **Who is the exact reader?** (library author, app developer, DX engineer, tech lead, etc.)
- **What do they already know?** (assumed knowledge)
- **What do they _not_ know yet (but need)?**
- **What environment constraints matter?** (frameworks, deployment model, TS level, DB/ORM, runtime)
- **What prerequisites should be explicitly listed at the top?**
- **What is explicitly out of scope?**

## 3) The hook (why they should care _now_)

- **What problem pain feels familiar to the reader?**
- **What’s a concrete failure mode / “ugh moment” you’ve seen in the wild?**
- **What’s the cost of the status quo?** (time, bugs, drift, security, cognitive load, maintenance)
- **What story can you open with (1–2 paragraphs) that makes the problem real?**
- **What’s the smallest example that demonstrates the pain in <60 seconds?**

## 4) The “before” picture (current approach)

- **How is this typically solved today?** (show the common pattern)
- **What glue code usually appears, and why?**
- **Where does complexity hide?** (edge cases, lifecycle, retries, ordering, auth, caching, schema
  drift)
- **What do people routinely get wrong?**
- **What trade-offs are they (unknowingly) accepting?**

## 5) The core idea (the concept you’re teaching)

- **What’s the core concept in neutral terms (no Fragno yet)?**
- **What are the key terms that must be defined on first use?**
- **What mental model should the reader adopt?** (metaphor/diagram-friendly model)
- **What are the 2–4 sub-ideas that build up to the main idea (in teaching order)?**
- **What is the “worked example” you’ll use throughout?** (one consistent scenario)

## 6) The solution (what you’re proposing)

- **What is the proposed approach at a high level?**
- **What are the components of the approach?** (frontend, backend, database, build step, ops)
- **What are the key design constraints you respected?** (framework-agnostic, type-safe, portable,
  etc.)
- **What are the non-goals / consciously rejected features?**
- **What does success look like?** (developer experience, integration time, fewer footguns)

## 7) “Why Fragno” (tie the idea to Fragno without making it an ad)

- **Which Fragno idea does this post exemplify?** (fragments, adapters, route definition, client
  hooks, code splitting, db layer, config/deps/services, middleware, etc.)
- **What does Fragno make _possible_ that’s hard otherwise?**
- **What does Fragno make _simpler_ (and for whom: library author vs user)?**
- **Where does Fragno intentionally _not_ take over?** (what remains app-specific)
- **What’s the minimal snippet that shows the Fragno “shape” of the solution?**
- **If the reader never uses Fragno, what idea should they still steal?**

## 8) Evidence + credibility (show, don’t assert)

- **What concrete artifacts can you include?** (code, diagram, schema, sequence diagram, flowchart)
- **What results can you quantify?** (time-to-integrate, LOC removed, fewer concepts, fewer failure
  modes)
- **What trade-offs did you encounter and how did you choose?**
- **What’s the “gotcha” section?** (where this approach can fail / needs care)
- **What’s the migration story from the status quo?** (incremental adoption path)

## 9) Structure choice (deep dive vs tutorial)

- **Is this a “Problem → Solution → Trade-offs” post or a step-by-step tutorial?**
- If tutorial: **What are the steps, and how does the reader verify each step worked?**
- If deep dive: **What’s the narrative arc?** (setup → confrontation → resolution)
- **What sections are “scan-friendly” anchors?** (headings that carry the argument)
- **Where will you place diagrams to reduce cognitive load?**

## 10) Reader outcomes (what they can do after)

- **What can the reader copy/paste and run?**
- **What can the reader adapt to their own stack?**
- **What checklist/heuristics can they reuse in future decisions?**
- **What are 3 crisp takeaways you’ll restate near the end?**

## 11) Call to action (helpful next step, not pushy)

- **What should the reader do next in 5 minutes?**
- **Which Fragno doc/page should you link as the “next step”?**
- **What feedback are you asking for (specific questions)?**
- **What’s the “try it yourself” path (repo/example/quickstart)?**

## 12) Packaging (title/summary/SEO without losing soul)

- **What’s the 1–2 sentence description (meta) that sets expectations?**
- **What search query should this post win?** (the phrase people would type)
- **What terms should appear in headings?**
- **What’s the one hero diagram/figure that could be shared standalone?**
