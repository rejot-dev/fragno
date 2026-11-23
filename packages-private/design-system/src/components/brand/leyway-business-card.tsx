import type { ReactNode } from "react";

import { Icon } from "../icon";
import { LeywayMark } from "./leyway-mark";
import { LeywayWordmark } from "./leyway-wordmark";

/** Who a card is for, in the order its back lists them. */
export type LeywayBusinessCardPerson = {
  name: string;
  role: string;
  email: string;
  phone: string;
  website: string;
};

/**
 * The card's front: flat ink, the landing page's black, with only the logo in white, large and
 * centered, about half the card's width.
 */
export function LeywayBusinessCardFront() {
  return (
    <CardFace className="bg-[#0b0b0a] text-white">
      <div className="absolute inset-0 flex items-center justify-center">
        <Lockup wordmarkHeightMm={10} />
      </div>
    </CardFace>
  );
}

/**
 * The card's back: the landing header's white and ink, as it shows over the page's light
 * sections, with whose card it is and how to reach them. The website sits in a round outlined
 * button like the header's "Open app".
 */
export function LeywayBusinessCardBack({ person }: { person: LeywayBusinessCardPerson }) {
  return (
    <CardFace className="bg-white text-[#0b0b0a]">
      <div className="absolute inset-0 flex flex-col justify-between px-[6mm] pt-[5.5mm] pb-[6mm]">
        <Lockup wordmarkHeightMm={4.5} />
        <div className="flex items-end justify-between gap-[3mm]">
          <div className="flex min-w-0 flex-col gap-[3mm]">
            <div>
              <p className="font-heading text-[5.2mm] leading-[1.05] font-light tracking-[-0.02em]">
                {person.name}
              </p>
              <p className="mt-[1mm] text-[2.4mm] leading-tight font-light text-[#0b0b0a]/60">
                {person.role}
              </p>
            </div>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-[2.5mm] gap-y-[0.8mm] text-[2.2mm] leading-tight">
              <ContactLine label="Email" value={person.email} />
              <ContactLine label="Phone" value={person.phone} />
            </dl>
          </div>
          <p className="inline-flex h-[6.5mm] shrink-0 items-center gap-[1mm] rounded-full border border-[#0b0b0a]/30 px-[3mm] text-[2.2mm] font-semibold">
            {/* Trimmed to cap height and baseline, so the letters center on the arrow, as in every
                round button on the landing page. */}
            <span className="[text-box:trim-both_cap_alphabetic]">{person.website}</span>
            <Icon name="arrow-right" className="size-[2.2mm]" />
          </p>
        </div>
      </div>
    </CardFace>
  );
}

// Cards are sized in millimetres, so they print at their real size: a European 85 × 55 mm card.
function CardFace({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div
      className={`relative h-[55mm] w-[85mm] shrink-0 overflow-hidden rounded-[3mm] font-sans shadow-[0_1px_2px_rgb(0_0_0/0.08),0_8px_24px_-12px_rgb(0_0_0/0.15)] ${className}`}
    >
      {children}
    </div>
  );
}

/** The mark before the wordmark, as tall as its lowercase, as the landing header sets them. */
function Lockup({ wordmarkHeightMm }: { wordmarkHeightMm: number }) {
  return (
    <div className="flex items-center gap-[0.3em]" style={{ fontSize: `${wordmarkHeightMm}mm` }}>
      <LeywayMark className="h-[calc(1em*480/920)] w-auto" />
      <LeywayWordmark className="h-[1em]" />
    </div>
  );
}

function ContactLine({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[#0b0b0a]/45">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </>
  );
}
