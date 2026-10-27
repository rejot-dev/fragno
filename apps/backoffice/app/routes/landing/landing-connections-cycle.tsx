import { LooppWordmark } from "@fragno-private/design-system/loopp-wordmark";
import { useEffect, useRef, useState } from "react";

import airtableUrl from "./connection-icons/airtable.svg?url";
import asanaUrl from "./connection-icons/asana.svg?url";
import discordUrl from "./connection-icons/discord.svg?url";
import dropboxUrl from "./connection-icons/dropbox.svg?url";
import figmaUrl from "./connection-icons/figma.svg?url";
import githubUrl from "./connection-icons/github.svg?url";
import gmailUrl from "./connection-icons/gmail.svg?url";
import googleCalendarUrl from "./connection-icons/google-calendar.svg?url";
import googleDriveUrl from "./connection-icons/google-drive.svg?url";
import jiraUrl from "./connection-icons/jira.svg?url";
import linearUrl from "./connection-icons/linear.svg?url";
import microsoftTeamsUrl from "./connection-icons/microsoft-teams.svg?url";
import notionUrl from "./connection-icons/notion.svg?url";
import onedriveUrl from "./connection-icons/onedrive.svg?url";
import salesforceUrl from "./connection-icons/salesforce.svg?url";
import shopifyUrl from "./connection-icons/shopify.svg?url";
import slackUrl from "./connection-icons/slack.svg?url";
import trelloUrl from "./connection-icons/trello.svg?url";
import whatsappUrl from "./connection-icons/whatsapp.svg?url";
import zoomUrl from "./connection-icons/zoom.svg?url";

const CONNECTIONS = [
  { name: "Slack", iconUrl: slackUrl },
  { name: "Gmail", iconUrl: gmailUrl },
  { name: "WhatsApp", iconUrl: whatsappUrl },
  { name: "Google Drive", iconUrl: googleDriveUrl },
  { name: "OneDrive", iconUrl: onedriveUrl },
  { name: "GitHub", iconUrl: githubUrl },
  { name: "Microsoft Teams", iconUrl: microsoftTeamsUrl },
  { name: "Notion", iconUrl: notionUrl },
  { name: "Google Calendar", iconUrl: googleCalendarUrl },
  { name: "Salesforce", iconUrl: salesforceUrl },
  { name: "Shopify", iconUrl: shopifyUrl },
  { name: "Jira", iconUrl: jiraUrl },
  { name: "Dropbox", iconUrl: dropboxUrl },
  { name: "Zoom", iconUrl: zoomUrl },
  { name: "Airtable", iconUrl: airtableUrl },
  { name: "Trello", iconUrl: trelloUrl },
  { name: "Linear", iconUrl: linearUrl },
  { name: "Asana", iconUrl: asanaUrl },
  { name: "Discord", iconUrl: discordUrl },
  { name: "Figma", iconUrl: figmaUrl },
];

const STEP_MS = 2200;
// How long an icon takes to move one slot; the wire only connects once it has settled.
const MOVE_MS = 700;
const CONNECT_MS = 350;
const DISCONNECT_MS = 250;
const SLOT_SPACING = 104;
const ICON_SIZE = 64;
const HIGHLIGHTED_ICON_SIZE = 92;
// The pipe runs past the hero's top and bottom edges, which hide the icons entering and leaving it.
const HEIGHT = CONNECTIONS.length * SLOT_SPACING + HIGHLIGHTED_ICON_SIZE;
const CENTER_Y = HEIGHT / 2;
// Room on the left for the highlighted icon's shadow.
const PIPE_X = HIGHLIGHTED_ICON_SIZE / 2 + 32;
// The hub's width at full size; on the landing page it takes the width of the header's last cell,
// so it fits between that cell's lines.
const HUB_WIDTH = 128;
// The wire runs from the highlighted icon's edge to the hub's edge, where pulses arrive. The line
// itself continues under the hub to its center, so a narrower hub never leaves a gap.
const WIRE_START_X = PIPE_X + HIGHLIGHTED_ICON_SIZE / 2;
const WIRE_END_X = WIRE_START_X + 160;
const HUB_X = WIRE_END_X + HUB_WIDTH / 2;
// The box ends at the hub's center, so placing the box's right edge places the hub.
const WIDTH = HUB_X;

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Connection icons stepping up a pipe past the Loopp hub; the icon level with the hub is
 * highlighted and wired to it. Decorative motion, so assistive technology reads
 * the list of connections instead.
 */
export function LandingConnectionsCycle() {
  // Each step first retracts the wire into the current icon and hides its name; only then do the
  // icons move. Once the next connection has settled level with the hub, the wire extends out to
  // the hub again, the name shows, and a pulse travels the wire.
  const [step, setStep] = useState(0);
  const wireRef = useRef<HTMLSpanElement>(null);
  const nameRef = useRef<HTMLParagraphElement>(null);
  const pulseRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (prefersReducedMotion()) {
      return undefined;
    }
    const interval = window.setInterval(() => {
      const disconnect = { duration: DISCONNECT_MS, easing: "ease-in", fill: "forwards" } as const;
      nameRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], disconnect);
      wireRef.current
        ?.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], disconnect)
        .finished.then(() => {
          setStep((current) => current + 1);
        })
        // Cancelled when the component unmounts mid-retract.
        .catch(() => {});
    }, STEP_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (step === 0) {
      return;
    }
    const total = MOVE_MS + CONNECT_MS;
    const settled = MOVE_MS / total;
    for (const element of [wireRef.current, nameRef.current]) {
      // The retract held its end state; this animation takes over from it.
      element?.getAnimations().forEach((animation) => {
        animation.cancel();
      });
    }
    wireRef.current?.animate(
      [
        { transform: "scaleX(0)" },
        { transform: "scaleX(0)", offset: settled, easing: "ease-out" },
        { transform: "scaleX(1)" },
      ],
      total,
    );
    nameRef.current?.animate(
      [{ opacity: 0 }, { opacity: 0, offset: settled, easing: "ease-out" }, { opacity: 1 }],
      total,
    );
    pulseRef.current?.animate(
      [
        { transform: "translateX(0)", opacity: 0 },
        { opacity: 1, offset: 0.2 },
        { opacity: 1, offset: 0.8 },
        { transform: `translateX(${WIRE_END_X - WIRE_START_X}px)`, opacity: 0 },
      ],
      { delay: total, duration: 800, easing: "ease-in-out", fill: "backwards" },
    );
  }, [step]);

  const active = CONNECTIONS[step % CONNECTIONS.length];

  return (
    <figure
      role="img"
      aria-label={`Loopp connects to ${CONNECTIONS.map((connection) => connection.name).join(", ")}.`}
      className="relative shrink-0"
      style={{ width: WIDTH, height: HEIGHT }}
    >
      <svg aria-hidden="true" className="absolute inset-0" width={WIDTH} height={HEIGHT}>
        <line
          x1={PIPE_X}
          y1={0}
          x2={PIPE_X}
          y2={HEIGHT}
          stroke="currentColor"
          strokeOpacity={0.15}
          strokeWidth={2}
        />
      </svg>
      <span
        ref={wireRef}
        aria-hidden="true"
        className="absolute h-[1.5px] origin-left -translate-y-1/2 bg-current"
        style={{ left: WIRE_START_X, top: CENTER_Y, width: HUB_X - WIRE_START_X }}
      />
      <span
        ref={pulseRef}
        aria-hidden="true"
        className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current opacity-0 shadow-[0_0_0_3px_rgb(255_255_255/0.9),0_0_16px_6px_rgb(255_255_255/0.9)]"
        style={{ left: WIRE_START_X, top: CENTER_Y }}
      />

      <span
        aria-hidden="true"
        className="absolute flex h-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[14px] bg-white text-[#0b0b0a] shadow-[0_1px_2px_rgba(11,11,10,0.12),0_10px_30px_-12px_rgba(11,11,10,0.35)]"
        style={{
          left: HUB_X,
          top: CENTER_Y,
          // The header's cell is measured on the page, so it is undone from the carousel's scale.
          width: `calc(var(--landing-header-open-width, ${HUB_WIDTH}px) / var(--landing-cycle-scale, 1))`,
        }}
      >
        <LooppWordmark className="h-6" animated={false} />
      </span>

      {CONNECTIONS.map((connection, index) => {
        const slot = pipeSlot(index, step);
        const highlighted = slot === 0;
        // An icon leaving at the top re-enters at the bottom, out of sight; animated, it would
        // sweep down across the hero.
        const reentering = slot === CONNECTIONS.length / 2;
        const size = highlighted ? HIGHLIGHTED_ICON_SIZE : ICON_SIZE;
        return (
          <span
            key={connection.name}
            aria-hidden="true"
            className={`absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[16px] bg-white ${
              reentering ? "" : "transition-[top,width,height,box-shadow] ease-out"
            } ${
              highlighted
                ? "shadow-[0_0_0_2px_currentColor,0_18px_40px_-14px_rgba(11,11,10,0.55)]"
                : "shadow-[0_1px_2px_rgba(11,11,10,0.12)]"
            }`}
            style={{
              left: PIPE_X,
              top: CENTER_Y + slot * SLOT_SPACING,
              width: size,
              height: size,
              // Without the transition class the default `all` would apply, so no duration either.
              transitionDuration: reentering ? undefined : `${MOVE_MS}ms`,
            }}
          >
            <img
              src={connection.iconUrl}
              alt=""
              className={highlighted ? "size-13" : "size-8"}
              draggable={false}
            />
          </span>
        );
      })}

      <p
        ref={nameRef}
        aria-hidden="true"
        className="absolute -translate-x-1/2 -translate-y-full pb-2.5 text-center text-xs leading-tight font-semibold tracking-[0.12em] text-current/70 uppercase"
        style={{
          left: (WIRE_START_X + WIRE_END_X) / 2,
          top: CENTER_Y,
          width: WIRE_END_X - WIRE_START_X,
        }}
      >
        {active.name}
      </p>
    </figure>
  );
}

/** Where `index` sits on the pipe at `step`: 0 is level with the hub, negative slots above it. */
function pipeSlot(index: number, step: number) {
  const count = CONNECTIONS.length;
  const offset = (((index - step) % count) + count) % count;
  return offset > count / 2 ? offset - count : offset;
}
