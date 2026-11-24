import { Link } from "react-router";

import calendlyUrl from "../../connection-icons/calendly.svg?url";
import gmailUrl from "../../connection-icons/gmail.svg?url";
import googleDriveUrl from "../../connection-icons/google-drive.svg?url";
import hubspotUrl from "../../connection-icons/hubspot.svg?url";
import slackUrl from "../../connection-icons/slack.svg?url";
import stripeUrl from "../../connection-icons/stripe.svg?url";
import { Icon, type IconName } from "../icon";
import {
  LANDING_FRAME_CLASS_NAME,
  LANDING_SECTION_TITLE_CLASS_NAME,
  LandingColumn,
} from "./landing-section";
import { ai, AiCount, ask, code, PanelLabel, type Step, StepRow } from "./workflow-steps";

type CaseWorkflow = {
  name: string;
  purpose: string;
  trigger: { icon: IconName; text: string };
  steps: readonly Step[];
};

type Case = {
  industry: string;
  icon: IconName;
  /** A photo from images.unsplash.com, free under the Unsplash License; the card sizes it. */
  image: string;
  headline: string;
  summary: string;
  business: string;
  before: string;
  workflows: readonly CaseWorkflow[];
  outcomes: readonly string[];
  tools: readonly CaseTool[];
};

// An app a case connects: a brand's own logo, or a generic icon for what no single brand stands for.
type CaseTool = {
  name: string;
  mark: { kind: "logo"; url: string } | { kind: "icon"; icon: IconName };
};

const TOOLS = {
  gmail: { name: "Gmail", mark: { kind: "logo", url: gmailUrl } },
  googleDrive: { name: "Google Drive", mark: { kind: "logo", url: googleDriveUrl } },
  slack: { name: "Slack", mark: { kind: "logo", url: slackUrl } },
  stripe: { name: "Stripe", mark: { kind: "logo", url: stripeUrl } },
  hubspot: { name: "HubSpot", mark: { kind: "logo", url: hubspotUrl } },
  calendly: { name: "Calendly", mark: { kind: "logo", url: calendlyUrl } },
  bank: { name: "Your bank", mark: { kind: "icon", icon: "credit-card" } },
} satisfies Record<string, CaseTool>;

// Example businesses, not customers: none is named and none claims a measured result, so the cases
// show how Leyway fits a kind of business without standing in for a reference.
export const LANDING_CASES = {
  "accounting-firm": {
    industry: "Accounting",
    icon: "file-text",
    // https://unsplash.com/photos/sW02MHv37yk
    image: "https://images.unsplash.com/photo-1762427907123-c7ab022a5de7",
    headline: "Receipts that book themselves",
    summary:
      "An accounting firm stops forwarding receipts by hand and only looks at the ones that don’t match.",
    business: "A small accounting firm doing the books for a few hundred freelancers and shops.",
    before:
      "Clients sent receipts by email, WhatsApp, and the occasional shoebox. Someone matched each one to a bank transaction, booked it, and chased the clients whose month was still incomplete. Every quarter ended with a week of reminders.",
    workflows: [
      {
        name: "book-receipt",
        purpose: "Every receipt a client emails is matched and booked, or put in front of you.",
        trigger: { icon: "mail", text: "A client emails a receipt" },
        steps: [
          ai("Which client, amount, and cost category?"),
          code("Match it to a bank transaction"),
          ask("An accountant checks receipts without a match"),
          code("Book it in the ledger"),
        ],
      },
      {
        name: "chase-statements",
        purpose: "Clients with an incomplete month get one reminder, listing what is missing.",
        trigger: { icon: "clock", text: "On the 5th of every month" },
        steps: [
          code("List transactions without a receipt, per client"),
          code("Fill in the reminder"),
          code("Email each client their list"),
        ],
      },
    ],
    outcomes: [
      "The team reviews exceptions instead of every receipt.",
      "Clients hear exactly which receipts are missing, once a month.",
      "Each booking links to the run that made it, for the auditor.",
    ],
    tools: [TOOLS.gmail, TOOLS.bank, TOOLS.googleDrive, TOOLS.slack],
  },
  "online-shop": {
    industry: "E-commerce",
    icon: "shopping-bag",
    // https://unsplash.com/photos/mwa_nzFpnJw
    image: "https://images.unsplash.com/photo-1603400521630-9f2de124b33b",
    headline: "Returns handled before the morning coffee",
    summary:
      "An online shop refunds the routine returns on its own and asks a person about the expensive ones.",
    business: "An online clothing shop shipping a few hundred orders a week.",
    before:
      "Every return request landed in a shared inbox. Someone read it, found the order, decided whether it qualified, made the refund, and emailed a label. On Mondays the inbox took the whole morning.",
    workflows: [
      {
        name: "handle-return",
        purpose:
          "Return requests are checked against the policy and refunded, with a person on big ones.",
        trigger: { icon: "clipboard", text: "A customer sends the return form" },
        steps: [
          ai("Damaged, wrong size, or changed their mind?"),
          code("Look up the order"),
          code("Stop if it is past the 30-day window"),
          ask("You approve refunds over €150"),
          code("Refund the payment in Stripe"),
          code("Email the return label"),
        ],
      },
      {
        name: "flag-damaged",
        purpose:
          "Damaged items are collected per supplier, so the claim is ready at the end of the week.",
        trigger: { icon: "clock", text: "Every Friday at 16:00" },
        steps: [
          code("Collect this week’s damaged returns"),
          code("Group them by supplier"),
          code("Post the list in #purchasing"),
        ],
      },
    ],
    outcomes: [
      "Routine returns are refunded the moment they come in.",
      "The policy is code, so every customer gets the same answer.",
      "Supplier claims start from a list instead of a search.",
    ],
    tools: [TOOLS.stripe, TOOLS.gmail, TOOLS.slack],
  },
  "recruitment-agency": {
    industry: "Recruitment",
    icon: "users",
    // https://unsplash.com/photos/jEpZNyFSQwQ
    image: "https://images.unsplash.com/photo-1758518730384-be3d205838e8",
    headline: "Every applicant gets an answer",
    summary:
      "A recruitment agency turns a pile of CVs into a shortlist, and recruiters choose who to call.",
    business: "A recruitment agency placing engineers and project managers.",
    before:
      "Applications came in through the website, LinkedIn, and email. Recruiters copied details into the CRM by hand, and good candidates waited days for a reply while weaker ones never heard back at all.",
    workflows: [
      {
        name: "intake-candidate",
        purpose: "Each application becomes a CRM contact with the facts a recruiter needs.",
        trigger: { icon: "inbox", text: "An application comes in" },
        steps: [
          ai("Role, years of experience, and availability?"),
          code("Add the candidate to HubSpot"),
          ai("Which open roles fit?"),
          ask("A recruiter picks who to contact"),
          code("Book an intro call in Calendly"),
        ],
      },
      {
        name: "close-application",
        purpose: "Candidates who are not a fit hear so within a week, politely.",
        trigger: { icon: "clock", text: "Every weekday at 17:00" },
        steps: [
          code("List applications rejected today"),
          code("Fill in the reply template"),
          code("Email each candidate"),
        ],
      },
    ],
    outcomes: [
      "Recruiters start their day with a shortlist, not an inbox.",
      "No candidate is left without an answer.",
      "The CRM is complete because nobody has to type it in.",
    ],
    tools: [TOOLS.hubspot, TOOLS.calendly, TOOLS.gmail, TOOLS.slack],
  },
  "property-management": {
    industry: "Property management",
    icon: "home",
    // https://unsplash.com/photos/90kZ3TlPhho
    image: "https://images.unsplash.com/photo-1763441344610-9c0946421fb2",
    headline: "Leaks reported, plumbers booked",
    summary:
      "A property manager routes repair requests to the right contractor and keeps tenants posted.",
    business: "A property manager looking after a few dozen apartment buildings.",
    before:
      "Tenants called, emailed, and texted about repairs. Office staff worked out the building, the kind of job, and which contractor to call, then forgot to tell the tenant when someone was coming.",
    workflows: [
      {
        name: "route-repair",
        purpose: "Each repair request reaches the building’s contractor for that kind of job.",
        trigger: { icon: "clipboard", text: "A tenant reports a repair" },
        steps: [
          ai("Plumbing, electrical, or other? How urgent?"),
          code("Look up the building’s contractor"),
          ask("You approve jobs over the building’s budget"),
          code("Send the job to the contractor"),
          code("Tell the tenant who is coming"),
        ],
      },
      {
        name: "chase-open-jobs",
        purpose: "Jobs nobody closed come back to the office before the tenant calls again.",
        trigger: { icon: "clock", text: "Every morning at 08:00" },
        steps: [
          code("List jobs open longer than three days"),
          code("Ask each contractor for a date"),
          code("Post the overdue ones in #maintenance"),
        ],
      },
    ],
    outcomes: [
      "Urgent leaks go out first, whoever is at the desk.",
      "Tenants hear who is coming without calling the office.",
      "Every job’s history is one place to look when a dispute comes up.",
    ],
    tools: [TOOLS.gmail, TOOLS.googleDrive, TOOLS.slack],
  },
} satisfies Record<string, Case>;

type CaseSlug = keyof typeof LANDING_CASES;

const CASE_SLUGS = Object.keys(LANDING_CASES) as CaseSlug[];

/**
 * The homepage's cases: one photo card per example business, each opening its own page, in a
 * rounded row inside the content column like a case page's other cases.
 */
export function LandingCases() {
  return (
    <section id="cases" aria-labelledby="landing-cases" className="scroll-mt-24">
      <LandingColumn>
        <div className="flex max-w-2xl flex-col gap-4">
          <h2 id="landing-cases" className={LANDING_SECTION_TITLE_CLASS_NAME}>
            How businesses run on Leyway
          </h2>
          <p className="max-w-xl text-base leading-7 text-pretty text-[var(--bo-muted)]">
            The same idea in three trades: the routine runs as code, AI answers one question at a
            time, and people sign off where it matters.
          </p>
        </div>
        {/* From xl the row reaches past the column by a fifth of the column on each side, short
            of 1.5rem from the window's edges. The outer cards take that bleed on top of a third of
            the column each and pad their text back by as much, so the photos grow while the text
            keeps its place and width in the column. */}
        <CaseCards
          slugs={CASE_SLUGS.slice(0, 3)}
          className="mt-10 overflow-hidden rounded-[14px] [--case-bleed:0px] xl:-mx-[var(--case-bleed)] xl:grid-cols-[calc(var(--case-bleed)+(100%-var(--case-bleed)*2)/3)_calc((100%-var(--case-bleed)*2)/3)_calc(var(--case-bleed)+(100%-var(--case-bleed)*2)/3)] xl:[--case-bleed:min(calc((min(100vw,var(--container-landing))-var(--spacing)*24)*0.2),calc((100vw-min(100vw,var(--container-landing))+var(--spacing)*24)/2-1.5rem))]"
        />
      </LandingColumn>
    </section>
  );
}

/**
 * A case's own page: the business, what it was like before, the workflows that run now, and what
 * changed. Ends on the other cases.
 */
export function LandingCase({ slug }: { slug: CaseSlug }) {
  const story: Case = LANDING_CASES[slug];

  return (
    <article>
      <Link
        to="/#cases"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--bo-muted)] no-underline transition-colors duration-150 hover:text-[var(--bo-fg)]"
      >
        <Icon name="arrow-left" className="size-4" />
        All cases
      </Link>

      <header className="mt-10 border-b border-[color:var(--bo-border)] pb-14">
        <p className="flex items-center gap-2 text-xs font-semibold tracking-[0.14em] text-[var(--bo-accent-strong)] uppercase">
          <Icon name={story.icon} className="size-4" />
          {story.industry}
          <span className="text-[var(--bo-muted-2)]">· Example case</span>
        </p>
        <h1 className="font-heading mt-5 max-w-4xl text-[clamp(2.75rem,6vw,5.25rem)] leading-[0.98] font-light tracking-[-0.06em] text-balance">
          {story.headline}
        </h1>
        <p className="mt-7 max-w-2xl text-lg leading-8 text-pretty text-[var(--bo-muted)]">
          {story.business} {story.summary}
        </p>
      </header>

      <div className="grid gap-12 py-14 lg:grid-cols-2 lg:gap-16">
        <section aria-labelledby="case-before">
          <h2 id="case-before" className="font-heading text-2xl font-light tracking-[-0.04em]">
            Before
          </h2>
          <p className="mt-4 text-base leading-7 text-pretty text-[var(--bo-muted)]">
            {story.before}
          </p>
        </section>
        <section aria-labelledby="case-after">
          <h2 id="case-after" className="font-heading text-2xl font-light tracking-[-0.04em]">
            With Leyway
          </h2>
          <ul className="mt-4 space-y-3">
            {story.outcomes.map((outcome) => (
              <li key={outcome} className="flex gap-3 text-base leading-7">
                <Icon
                  name="check"
                  className="mt-1.5 size-4 shrink-0 text-[var(--bo-accent-strong)]"
                />
                {outcome}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section aria-labelledby="case-workflows">
        <h2
          id="case-workflows"
          className="font-heading text-[clamp(1.75rem,3vw,2.5rem)] leading-[1.1] font-light tracking-[-0.05em]"
        >
          The workflows
        </h2>
        <p className="mt-4 max-w-2xl text-base leading-7 text-pretty text-[var(--bo-muted)]">
          Described to an agent in a sentence or two, written as code you can read, and run the same
          way every time.
        </p>
        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          {story.workflows.map((workflow) => (
            <WorkflowCard key={workflow.name} workflow={workflow} />
          ))}
        </div>
        <p className="mt-8 flex flex-wrap items-center gap-2 text-sm text-[var(--bo-muted)]">
          Connected to
          {story.tools.map((tool) => (
            <span
              key={tool.name}
              className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] py-1 pr-3 pl-2 text-xs font-medium text-[var(--bo-fg)]"
            >
              <ToolMark tool={tool} className="size-3.5" />
              {tool.name}
            </span>
          ))}
        </p>
      </section>

      <section aria-labelledby="case-others" className="mt-24">
        <h2 id="case-others" className="font-heading text-2xl font-light tracking-[-0.04em]">
          More cases
        </h2>
        <CaseCards
          slugs={CASE_SLUGS.filter((other) => other !== slug)}
          className="mt-8 overflow-hidden rounded-[14px] xl:grid-cols-3"
        />
      </section>
    </article>
  );
}

/** Which sides of a card lean: the row's outer edges stay straight, the edges between cards slant. */
type Slant = "right" | "both" | "left";

// Per slant, from xl, where the cards share one row: the card reaches half a slant into each
// slanted neighbor and its clip cuts the slant, the left one 1px past it, under which the
// neighbor's photo continues, so no seam of the page shows between cards. The outer cards keep
// their text --case-bleed further in, where a row reaches past its column. The text sits in the
// card's middle, so it only needs to clear a slant there: three quarters of the slant, where the
// slant crosses the text's lowest or highest line, keeps it clear of either side.
// The industry heads the card, clear of a left slant's top corner; the last card's text starts
// there too, so the two share one left edge. The middle card's block is about as wide as its
// longest lines and centered between its slants, its lines still starting on one left edge; at
// full width, its ragged right side would make it look pushed left.
const SLANT_CLASS_NAMES = {
  right: {
    item: "xl:-mr-[calc(var(--case-slant)/2)]",
    clip: "xl:[clip-path:polygon(0_0,100%_0,calc(100%-var(--case-slant))_100%,0_100%)]",
    text: "xl:pl-[calc(var(--case-bleed,0px)+1.5rem)] xl:pr-[calc(var(--case-slant)*0.75+0.75rem)]",
    footer:
      "xl:left-[calc(var(--case-bleed,0px)+1.5rem)] xl:right-[calc(var(--case-slant)+0.75rem)]",
    label: "xl:left-[calc(var(--case-bleed,0px)+1.5rem)]",
    body: "",
  },
  both: {
    item: "xl:-mx-[calc(var(--case-slant)/2)]",
    clip: "xl:[clip-path:polygon(calc(var(--case-slant)-1px)_0,100%_0,calc(100%-var(--case-slant))_100%,-1px_100%)]",
    text: "xl:px-[calc(var(--case-slant)*0.75+0.75rem)]",
    footer: "xl:left-14 xl:right-[calc(var(--case-slant)+0.75rem)]",
    label: "xl:left-[calc(var(--case-slant)+0.75rem)]",
    body: "xl:mx-auto xl:max-w-[15rem]",
  },
  left: {
    item: "xl:-ml-[calc(var(--case-slant)/2)]",
    clip: "xl:[clip-path:polygon(calc(var(--case-slant)-1px)_0,100%_0,100%_100%,-1px_100%)]",
    text: "xl:pl-[calc(var(--case-slant)+0.75rem)] xl:pr-[calc(var(--case-bleed,0px)+1.5rem)]",
    footer: "xl:left-14 xl:right-[calc(var(--case-bleed,0px)+1.5rem)]",
    label: "xl:left-[calc(var(--case-slant)+0.75rem)]",
    body: "",
  },
} satisfies Record<
  Slant,
  { item: string; clip: string; text: string; footer: string; label: string; body: string }
>;

/**
 * Photo cards set flush against each other. From xl they share one row and their sides between
 * them lean like the header's call to action, at the wordmark's angle, so the row reads as a run of
 * slashes. The list's class name decides the columns and whether the row is rounded.
 */
function CaseCards({ slugs, className }: { slugs: readonly CaseSlug[]; className: string }) {
  return (
    <ul
      className={`grid [--case-height:30rem] [--case-slant:calc(var(--case-height)*tan(24.83deg))] sm:grid-cols-2 ${className}`}
    >
      {slugs.map((slug, index) => {
        const story: Case = LANDING_CASES[slug];
        const steps = story.workflows.flatMap((workflow) => workflow.steps);
        const slant: Slant = index === 0 ? "right" : index === slugs.length - 1 ? "left" : "both";
        const slantClassNames = SLANT_CLASS_NAMES[slant];
        // In two columns, before xl, an odd row's last card would stand alone beside an empty
        // slot; it fills the row instead, twice as wide and as tall as the pair above it, with its
        // text block kept a card's width and started as far down.
        const fillsRow = index === slugs.length - 1 && slugs.length % 2 === 1;
        return (
          <li
            key={slug}
            className={`flex ${slantClassNames.item} ${fillsRow ? "sm:col-span-2 xl:col-span-1" : ""}`}
          >
            {/* Not a link yet: the case pages stay unpublished until they are ready, so the card
                does not navigate. Hovering still clears its glass, to show the photo. */}
            <div
              className={`group relative isolate flex min-h-[26rem] w-full flex-col overflow-hidden bg-[#0b0b0a] p-6 text-white ${fillsRow ? "sm:aspect-[2/1]" : "sm:aspect-square"} sm:min-h-0 xl:block xl:aspect-auto xl:h-[var(--case-height)] xl:pt-[calc(var(--case-height)*0.3)] xl:pb-20 ${slantClassNames.clip} ${slantClassNames.text}`}
            >
              <img
                src={`${story.image}?auto=format&fit=crop&w=1200&q=70`}
                alt=""
                loading="lazy"
                decoding="async"
                className="absolute inset-0 -z-10 size-full object-cover"
              />
              {/* Frosted glass over the photo keeps the white text readable: the blur takes out the
                  detail that fights the letters, and a light tint the brightest highlights. */}
              <span
                aria-hidden="true"
                // Hovered, the glass clears to show the photo sharp, under a deeper shade that keeps
                // the text readable on its full detail.
                className="absolute inset-0 -z-10 bg-black/35 backdrop-blur-sm transition-[background-color,backdrop-filter] duration-500 ease-out group-hover:bg-black/60 group-hover:backdrop-blur-[0px]"
              />
              {/* The industry heads the card. The rest starts at the same height on every card,
                  about a third down, so the headings line up across a row while each block sits
                  near the middle. Past a left slant's top corner, the industry clears the cut. */}
              <span
                className={`block text-[11px] font-semibold tracking-[0.14em] text-white/75 uppercase xl:absolute xl:top-6 ${slantClassNames.label}`}
              >
                {story.industry}
              </span>
              <span
                className={`mt-[30%] mb-auto block pb-8 xl:mt-0 xl:pb-0 ${fillsRow ? "sm:mt-[10%] sm:max-w-[calc(50%-3rem)] xl:max-w-none" : "sm:mt-[20%]"} ${slantClassNames.body}`}
              >
                <span className="font-heading block text-2xl leading-[1.15] font-light tracking-[-0.04em] text-balance">
                  {story.headline}
                </span>
                <span className="mt-3 block text-sm leading-6 text-pretty text-white/85">
                  {story.summary}
                </span>
                {/* The apps the case's workflows connect, frosted over the photo. */}
                <span className="mt-4 flex flex-wrap gap-1.5" aria-label="Connected apps">
                  {story.tools.map((tool) => (
                    <span
                      key={tool.name}
                      className="inline-flex items-center gap-2 rounded-full bg-white/15 py-1 pr-3 pl-1 text-xs font-medium text-white backdrop-blur-sm"
                    >
                      {/* Logos sit on a white disc so their own colors read over any photo. */}
                      <span className="flex size-5 items-center justify-center rounded-full bg-white">
                        <ToolMark tool={tool} className="size-3 text-[#0b0b0a]" />
                      </span>
                      {tool.name}
                    </span>
                  ))}
                </span>
              </span>
              <span
                className={`flex items-center justify-between gap-3 border-t border-white/20 pt-4 text-xs text-white/75 xl:absolute xl:bottom-6 xl:mt-0 ${slantClassNames.footer}`}
              >
                {story.workflows.length} workflows · {steps.length} steps
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function WorkflowCard({ workflow }: { workflow: CaseWorkflow }) {
  return (
    <div className={`${LANDING_FRAME_CLASS_NAME} bg-[var(--bo-panel)] p-4 sm:p-6`}>
      <div className="flex items-baseline justify-between gap-3">
        <PanelLabel>What runs every time</PanelLabel>
        <span className="truncate font-mono text-[11px] text-[var(--bo-muted-2)]">
          {workflow.name}.workflow.js
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-pretty">{workflow.purpose}</p>

      <div className="mt-5 flex items-center gap-2.5 rounded-t-[10px] border border-[color:var(--bo-border)] px-4 py-3 text-sm">
        <Icon
          name={workflow.trigger.icon}
          className="size-4 shrink-0 text-[var(--bo-accent-strong)]"
        />
        {workflow.trigger.text}
      </div>
      <ol className="overflow-hidden rounded-b-[10px] border-x border-b border-[color:var(--bo-border)]">
        {workflow.steps.map((step, index) => (
          <StepRow key={step.text} step={step} number={index + 1} added={false} />
        ))}
      </ol>

      <p className="mt-4 text-xs leading-5 text-[var(--bo-muted)]">
        <AiCount steps={workflow.steps} />
      </p>
    </div>
  );
}

function ToolMark({ tool, className }: { tool: CaseTool; className: string }) {
  switch (tool.mark.kind) {
    case "logo":
      return <img src={tool.mark.url} alt="" className={`block shrink-0 ${className}`} />;
    case "icon":
      return <Icon name={tool.mark.icon} className={`shrink-0 ${className}`} />;
    default:
      throw new Error("Unsupported tool mark.", { cause: tool.mark satisfies never });
  }
}
