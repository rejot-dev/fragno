import type { ReactNode } from "react";

import { LooppWordmark } from "./loopp-wordmark";

/** Who a card is for, in the order its back lists them. */
export type LooppBusinessCardPerson = {
  name: string;
  role: string;
  email: string;
  phone: string;
  website: string;
};

// Cards are sized in millimetres, so they print at their real size: a European 85 × 55 mm card.
// The loop is drawn in tenths of a millimetre.
const CARD_WIDTH = 850;
const CARD_HEIGHT = 550;

// The loop keeps the wordmark's stretched "o": its opening is this many times as wide as tall.
// Six lanes run round it, together more than twice as wide as the wordmark's stroke is to the
// opening, so the lines stay well apart at a card's size.
const HOLE_ASPECT = (200 + 2 * 92 - 66) / (2 * 85 - 66);
const LANES = 6;
const LANE_SHARE = (2.25 * 66) / (2 * 85 - 66) / LANES;

/** The card's front: the loop opening across it, with the wordmark inside. */
export function LooppBusinessCardFront() {
  const holeHeight = 230;
  return (
    <CardFace className="bg-[var(--bo-accent)] text-white">
      <Loop
        centerX={CARD_WIDTH / 2}
        centerY={CARD_HEIGHT / 2}
        holeHeight={holeHeight}
        fillClassName={null}
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <LooppWordmark className="h-[9mm]" animated={false} />
      </div>
    </CardFace>
  );
}

/** The card's back: whose card it is and how to reach them, with a slice of the loop. */
export function LooppBusinessCardBack({ person }: { person: LooppBusinessCardPerson }) {
  return (
    <CardFace className="bg-[var(--bo-bg)] text-[var(--bo-fg)]">
      {/* The front's loop, off the card's bottom right corner, so the back reads as its reverse. */}
      <Loop
        centerX={CARD_WIDTH + 110}
        centerY={CARD_HEIGHT + 20}
        holeHeight={110}
        fillClassName="fill-[var(--bo-accent)]"
      />
      <div className="absolute inset-0 flex flex-col justify-between p-[6mm]">
        <LooppWordmark className="h-[5mm] self-start" animated={false} />
        <div className="flex flex-col gap-[3mm]">
          <div>
            <p className="text-[3.6mm] leading-tight font-semibold tracking-[-0.01em]">
              {person.name}
            </p>
            <p className="mt-[0.6mm] text-[2.5mm] leading-tight text-[var(--bo-muted)]">
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
    </CardFace>
  );
}

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

/**
 * The stretched "o" centered on a point, in one color: `fillClassName`'s fill (null leaves the
 * card's own background), with white lines marking its opening and the lanes running round it,
 * past the card's edges where they reach them.
 */
function Loop({
  centerX,
  centerY,
  holeHeight,
  fillClassName,
}: {
  centerX: number;
  centerY: number;
  holeHeight: number;
  fillClassName: string | null;
}) {
  const holeWidth = holeHeight * HOLE_ASPECT;
  const lane = holeHeight * LANE_SHARE;
  const ring = (offset: number) => {
    const width = holeWidth + 2 * offset;
    const height = holeHeight + 2 * offset;
    return {
      x: centerX - width / 2,
      y: centerY - height / 2,
      width,
      height,
      rx: height / 2,
    };
  };
  return (
    <svg
      viewBox={`0 0 ${CARD_WIDTH} ${CARD_HEIGHT}`}
      aria-hidden="true"
      className="absolute inset-0 size-full"
    >
      {fillClassName ? <rect {...ring(lane * LANES)} className={fillClassName} /> : null}
      {Array.from({ length: LANES + 1 }, (_, index) => (
        <rect
          key={index}
          {...ring(lane * index)}
          fill="none"
          className="stroke-white/25"
          strokeWidth={1.5}
        />
      ))}
    </svg>
  );
}
