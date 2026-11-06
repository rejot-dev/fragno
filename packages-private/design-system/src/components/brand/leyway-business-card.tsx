import type { ReactNode } from "react";

import { LeywayWordmark } from "./leyway-wordmark";

/** Who a card is for, in the order its back lists them. */
export type LeywayBusinessCardPerson = {
  name: string;
  role: string;
  email: string;
  phone: string;
  website: string;
};

/** The card's front: the landing page's red film, with the wordmark in white. */
export function LeywayBusinessCardFront() {
  return (
    <CardFace className="bg-[#d24a33] text-white">
      {/* The film's vignette is sized for a page; a card takes one sized for itself. */}
      <div
        aria-hidden="true"
        className="landing-film shadow-[inset_0_0_14mm_1mm_rgb(48_12_6/0.5)]!"
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <LeywayWordmark className="h-[9mm]" />
      </div>
    </CardFace>
  );
}

/** The card's back: whose card it is and how to reach them, on the landing page's graph paper. */
export function LeywayBusinessCardBack({ person }: { person: LeywayBusinessCardPerson }) {
  return (
    <CardFace className="bg-[var(--bo-bg)] text-[var(--bo-fg)]">
      <div aria-hidden="true" className="landing-grid [background-size:100%_5mm]" />
      {/* The landing header's column lines, at the card's margins. */}
      <div
        aria-hidden="true"
        className="absolute inset-y-0 left-[6mm] border-l border-[color-mix(in_srgb,var(--bo-fg)_7%,transparent)]"
      />
      <div
        aria-hidden="true"
        className="absolute inset-y-0 right-[6mm] border-r border-[color-mix(in_srgb,var(--bo-fg)_7%,transparent)]"
      />
      <div className="absolute inset-0 flex flex-col justify-between p-[6mm]">
        <LeywayWordmark className="h-[5mm] self-start" />
        <div className="flex flex-col gap-[3mm]">
          <div>
            <p className="font-heading text-[5mm] leading-[1.05] font-light tracking-[-0.04em]">
              {person.name}
            </p>
            <p className="mt-[1mm] text-[2.5mm] leading-tight text-[var(--bo-muted)]">
              {person.role}
            </p>
          </div>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-[2.5mm] gap-y-[0.8mm] text-[2.3mm] leading-tight">
            <ContactLine label="Email" value={person.email} />
            <ContactLine label="Phone" value={person.phone} />
            <ContactLine label="Web" value={person.website} />
          </dl>
        </div>
      </div>
      {/* A strip of the front's red along the bottom edge, so the back reads as its reverse. */}
      <div
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 h-[2mm] overflow-hidden bg-[#d24a33]"
      >
        <div className="landing-film" />
      </div>
    </CardFace>
  );
}

// Cards are sized in millimetres, so they print at their real size: a European 85 × 55 mm card.
function CardFace({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div
      className={`relative h-[55mm] w-[85mm] shrink-0 overflow-hidden rounded-[3mm] font-sans shadow-[0_1px_2px_rgb(0_0_0/0.08),0_8px_24px_-12px_rgb(0_0_0/0.3)] ${className}`}
    >
      {children}
    </div>
  );
}

function ContactLine({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[var(--bo-muted-2)]">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </>
  );
}
