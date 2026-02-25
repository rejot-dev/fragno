import {
  AbsoluteFill,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/SpaceGrotesk";
import { type ReactNode } from "react";
import { Astro } from "@/components/logos/frameworks/astro";
import { Drizzle } from "@/components/logos/frameworks/drizzle";
import { Kysely } from "@/components/logos/frameworks/kysely";
import { Nextjs } from "@/components/logos/frameworks/nextjs";
import { Nodejs } from "@/components/logos/frameworks/nodejs";
import { Nuxt } from "@/components/logos/frameworks/nuxt";
import { Prisma } from "@/components/logos/frameworks/prisma";
import { React as ReactLogo } from "@/components/logos/frameworks/react";
import { Solid } from "@/components/logos/frameworks/solid";
import { Svelte } from "@/components/logos/frameworks/svelte";
import { Vue } from "@/components/logos/frameworks/vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export type FragnoOverviewVideoProps = {
  appName: string;
};

const SCENE_1_DURATION = 110;
const SCENE_2_DURATION = 115;
const SCENE_3_DURATION = 125;
const SCENE_4_DURATION = 120;
const SCENE_5_DURATION = 130;
const BASE_WIDTH = 1920;
const BASE_HEIGHT = 1080;
const { fontFamily } = loadFont("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["latin"],
});
const FONT_FAMILY = `${fontFamily}, ui-sans-serif, system-ui`;

const FRAME = {
  scene1: 0,
  scene2: SCENE_1_DURATION,
  scene3: SCENE_1_DURATION + SCENE_2_DURATION,
  scene4: SCENE_1_DURATION + SCENE_2_DURATION + SCENE_3_DURATION,
  scene5: SCENE_1_DURATION + SCENE_2_DURATION + SCENE_3_DURATION + SCENE_4_DURATION,
} as const;

type MotionVariant = "soft" | "snappy";

const COLORS = {
  cardBorder: "rgba(148, 163, 184, 0.28)",
  stripe: "#635bff",
};

type LogoComponent = (props: { className?: string }) => ReactNode;
type LogoItem = {
  name: string;
  color: string;
  icon?: LogoComponent;
  scale?: number;
};

const FRAMEWORK_ITEMS: readonly LogoItem[] = [
  { name: "React", icon: ReactLogo, color: "#0ea5e9", scale: 0.95 },
  { name: "Vue", icon: Vue, color: "#22c55e", scale: 0.95 },
  { name: "Svelte", icon: Svelte, color: "#ef4444", scale: 0.95 },
  { name: "SolidJS", icon: Solid, color: "#3b82f6", scale: 0.43 },
  { name: "Astro", icon: Astro, color: "#111827", scale: 0.95 },
  { name: "Next.js", icon: Nextjs, color: "#111827", scale: 0.95 },
  { name: "Nuxt", icon: Nuxt, color: "#22c55e", scale: 0.95 },
  { name: "Node.js", icon: Nodejs, color: "#16a34a", scale: 0.95 },
] as const;

const DATA_ITEMS: readonly LogoItem[] = [
  { name: "PostgreSQL", color: "#334155" },
  { name: "MySQL", color: "#334155" },
  { name: "SQLite", color: "#334155" },
  { name: "Drizzle", icon: Drizzle, color: "#17161b", scale: 0.38 },
  { name: "Prisma", icon: Prisma, color: "#111827", scale: 0.56 },
  { name: "Kysely", icon: Kysely, color: "#111827", scale: 0.38 },
] as const;

type AnimInput = {
  frame: number;
  fps: number;
  delay?: number;
  durationInFrames?: number;
  variant?: MotionVariant;
  scale?: number;
};

const MOTION_PRESETS: Record<
  MotionVariant,
  { springConfig: Parameters<typeof spring>[0]["config"]; fromY: number; durationInFrames: number }
> = {
  snappy: {
    springConfig: { damping: 200 },
    fromY: 24,
    durationInFrames: 18,
  },
  soft: {
    springConfig: { damping: 26, stiffness: 100, mass: 0.9 },
    fromY: 34,
    durationInFrames: 24,
  },
};

const getScale = (width: number, height: number) =>
  Math.min(width / BASE_WIDTH, height / BASE_HEIGHT);
const s = (value: number, scale: number) => Math.round(value * scale * 100) / 100;

const fadeSlideUp = ({
  frame,
  fps,
  delay = 0,
  durationInFrames,
  variant = "snappy",
  scale = 1,
}: AnimInput) => {
  const preset = MOTION_PRESETS[variant];
  const progress = spring({
    frame: frame - delay,
    fps,
    durationInFrames: durationInFrames ?? preset.durationInFrames,
    config: preset.springConfig,
  });

  return {
    opacity: interpolate(progress, [0, 1], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }),
    transform: `translateY(${interpolate(progress, [0, 1], [preset.fromY * scale, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })}px)`,
  };
};

function CodePanel({
  children,
  fontSize = 24,
  scale = 1,
}: {
  children: ReactNode;
  fontSize?: number;
  scale?: number;
}) {
  return (
    <div
      className="self-start rounded-2xl bg-slate-900 font-mono text-slate-50 shadow-2xl"
      style={{
        borderRadius: s(16, scale),
        padding: `${s(18, scale)}px ${s(22, scale)}px`,
        fontSize: s(fontSize, scale),
        lineHeight: 1.45,
      }}
    >
      {children}
    </div>
  );
}

function LogoTile({
  item,
  scale,
  large = false,
}: {
  item: LogoItem;
  scale: number;
  large?: boolean;
}) {
  const Icon = item.icon;
  const tileSize = large ? s(132, scale) : s(118, scale);

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className="flex items-center justify-center overflow-hidden rounded-2xl border border-slate-300/50 bg-white/90"
        style={{
          width: tileSize,
          height: tileSize,
          borderRadius: s(16, scale),
          color: item.color,
        }}
      >
        {Icon ? (
          <div style={{ transform: `scale(${item.scale ?? 1})` }}>{Icon({})}</div>
        ) : (
          <div style={{ fontSize: s(24, scale) }}>DB</div>
        )}
      </div>
      <div className="font-bold leading-none text-slate-600" style={{ fontSize: s(21, scale) }}>
        {item.name}
      </div>
    </div>
  );
}

function BackgroundFrame() {
  const { width, height } = useVideoConfig();
  const scale = getScale(width, height);

  return (
    <div
      className="absolute overflow-hidden border border-slate-300/40 shadow-2xl"
      style={{
        inset: s(36, scale),
        borderRadius: s(30, scale),
      }}
    >
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(1200px 520px at 8% -10%, rgba(14,165,233,0.24), transparent 62%), radial-gradient(1200px 620px at 92% -20%, rgba(99,91,255,0.2), transparent 64%), linear-gradient(140deg, #f8fafc 0%, #eef2ff 48%, #ecfeff 100%)",
        }}
      />
    </div>
  );
}

function Scene1() {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const scale = getScale(width, height);

  const title = fadeSlideUp({ frame, fps, delay: 0, variant: "soft", scale });
  const subtitle = fadeSlideUp({ frame, fps, delay: 8, variant: "soft", scale });

  const items = [
    { label: "Auth", text: "#7c3aed", area: "1 / 1 / 2 / 2" },
    { label: "Billing", text: "#2563eb", area: "1 / 2 / 2 / 3" },
    { label: "Forms", text: "#0891b2", area: "1 / 3 / 2 / 4" },
    { label: "Agent", text: "#ea580c", area: "2 / 1 / 3 / 2" },
    { label: "File Uploads", text: "#16a34a", area: "2 / 2 / 3 / 4" },
  ] as const;

  return (
    <AbsoluteFill style={{ padding: s(92, scale), fontFamily: FONT_FAMILY }}>
      <div
        className="font-extrabold leading-tight text-slate-900"
        style={{
          ...title,
          fontSize: s(72, scale),
          lineHeight: 1.05,
        }}
      >
        Fragno: Integrate full-stack in minutes
      </div>

      <div
        className="text-slate-600"
        style={{
          ...subtitle,
          marginTop: s(22, scale),
          maxWidth: s(1320, scale),
          fontSize: s(34, scale),
          lineHeight: 1.28,
        }}
      >
        Drop in modular app building blocks into any TypeScript Stack
      </div>

      <div
        className="grid grid-cols-3 grid-rows-2"
        style={{
          marginTop: s(26, scale),
          width: s(1540, scale),
          height: s(430, scale),
          gap: s(14, scale),
        }}
      >
        {items.map((item, index) => {
          const anim = fadeSlideUp({
            frame,
            fps,
            delay: 14 + index * 8,
            durationInFrames: 16,
            variant: "snappy",
            scale,
          });
          return (
            <span
              key={item.label}
              className="flex items-center justify-center rounded-xl bg-white/95 font-extrabold leading-none shadow-md"
              style={{
                ...anim,
                color: item.text,
                border: `${s(1.5, scale)}px solid rgba(203,213,225,0.95)`,
                borderRadius: s(12, scale),
                padding: `${s(16, scale)}px ${s(18, scale)}px`,
                gridArea: item.area,
                fontSize: s(42, scale),
                lineHeight: 1,
              }}
            >
              {item.label}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

function Scene2() {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const scale = getScale(width, height);

  const title = fadeSlideUp({ frame, fps, delay: 0, variant: "soft", scale });
  const intro = fadeSlideUp({ frame, fps, delay: 6, variant: "soft", scale });
  const install = fadeSlideUp({ frame, fps, delay: 12, variant: "snappy", scale });
  const logoTitle = fadeSlideUp({ frame, fps, delay: 20, variant: "soft", scale });
  const logos = fadeSlideUp({ frame, fps, delay: 24, variant: "snappy", scale });

  return (
    <AbsoluteFill style={{ padding: s(92, scale), fontFamily: FONT_FAMILY }}>
      <div
        className="font-extrabold leading-tight text-slate-900"
        style={{
          ...title,
          fontSize: s(66, scale),
          lineHeight: 1.06,
        }}
      >
        Integrating Fragno fragments is simple
      </div>

      <div
        className="font-semibold text-slate-600"
        style={{
          ...intro,
          marginTop: s(16, scale),
          fontSize: s(34, scale),
        }}
      >
        Install and configure, skip glue code and start building quickly
      </div>

      <div style={{ ...install, marginTop: s(16, scale) }}>
        <CodePanel fontSize={28} scale={scale}>
          <span className="text-amber-300">npm</span> <span className="text-blue-300">install</span>{" "}
          <span className="text-emerald-300">@fragno-dev/stripe</span>{" "}
          <span className="text-emerald-300">@fragno-dev/db</span>
        </CodePanel>
      </div>

      <div
        className="font-bold text-slate-600"
        style={{
          ...logoTitle,
          marginTop: s(22, scale),
          fontSize: s(30, scale),
        }}
      >
        Works in every major framework:
      </div>

      <div
        className="grid grid-cols-4"
        style={{
          ...logos,
          marginTop: s(14, scale),
          gap: s(18, scale),
          maxWidth: s(1380, scale),
        }}
      >
        {FRAMEWORK_ITEMS.map((item) => (
          <LogoTile key={item.name} item={item} scale={scale} />
        ))}
      </div>
    </AbsoluteFill>
  );
}

function Scene3() {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const scale = getScale(width, height);

  const title1 = fadeSlideUp({ frame, fps, delay: 0, variant: "soft", scale });
  const title2 = fadeSlideUp({ frame, fps, delay: 8, variant: "soft", scale });
  const supportTitle = fadeSlideUp({ frame, fps, delay: 20, variant: "snappy", scale });
  const supportList = fadeSlideUp({ frame, fps, delay: 25, variant: "snappy", scale });

  return (
    <AbsoluteFill style={{ padding: s(92, scale), fontFamily: FONT_FAMILY }}>
      <div
        className="font-extrabold leading-tight text-slate-900"
        style={{
          ...title1,
          fontSize: s(58, scale),
          lineHeight: 1.1,
          maxWidth: s(1540, scale),
        }}
      >
        Fragments manage data schema for you.
      </div>

      <div
        className="font-bold text-slate-600"
        style={{
          ...title2,
          marginTop: s(10, scale),
          fontSize: s(45, scale),
          lineHeight: 1.12,
          maxWidth: s(1540, scale),
        }}
      >
        You stay in control of your own data.
      </div>

      <div
        className="font-bold text-slate-600"
        style={{
          ...supportTitle,
          marginTop: s(18, scale),
          fontSize: s(27, scale),
        }}
      >
        Compatible databases and ORMs:
      </div>

      <div
        className="grid grid-cols-3 border border-slate-300/50 bg-white/85"
        style={{
          ...supportList,
          marginTop: s(10, scale),
          borderRadius: s(22, scale),
          padding: s(22, scale),
          maxWidth: s(1520, scale),
          gap: s(16, scale),
        }}
      >
        {DATA_ITEMS.map((item) => (
          <LogoTile key={item.name} item={item} scale={scale} large />
        ))}
      </div>
    </AbsoluteFill>
  );
}

function Scene4() {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const scale = getScale(width, height);

  const title1 = fadeSlideUp({ frame, fps, delay: 0, variant: "soft", scale });
  const title2 = fadeSlideUp({ frame, fps, delay: 8, variant: "soft", scale });
  const pricingAnim = fadeSlideUp({ frame, fps, delay: 20, variant: "snappy", scale });

  return (
    <AbsoluteFill style={{ padding: s(92, scale), fontFamily: FONT_FAMILY }}>
      <div
        className="font-extrabold leading-tight text-slate-900"
        style={{
          ...title1,
          fontSize: s(57, scale),
          lineHeight: 1.1,
          maxWidth: s(1600, scale),
        }}
      >
        Frontend hooks included
      </div>

      <div
        className="font-bold text-slate-600"
        style={{
          ...title2,
          marginTop: s(10, scale),
          fontSize: s(43, scale),
          lineHeight: 1.12,
          maxWidth: s(1600, scale),
        }}
      >
        Quickly build your UI, no glue code required
      </div>

      <div
        className="grid grid-cols-2"
        style={{
          ...pricingAnim,
          marginTop: s(24, scale),
          gridTemplateColumns: "0.8fr 1.2fr",
          gap: s(24, scale),
          width: s(1560, scale),
        }}
      >
        <CodePanel fontSize={29} scale={scale}>
          <div>
            <span className="text-violet-300">const</span>{" "}
            <span className="text-slate-50">{"{ mutate, loader }"}</span>{" "}
            <span className="text-slate-50">= </span>
          </div>
          <div className="ml-6" style={{ marginLeft: s(24, scale) }}>
            <span className="text-amber-300">stripe</span>
            <span className="text-slate-50">.</span>
            <span className="text-blue-300">upgradeSubscription</span>
            <span className="text-slate-50">()</span>;
          </div>
        </CodePanel>

        <div
          className="mt-2 flex items-start justify-center"
          style={{
            marginTop: s(8, scale),
          }}
        >
          {[0, 1, 2].map((index) => {
            const featured = index === 1;
            return (
              <Card
                key={index}
                className={
                  featured ? "relative bg-white shadow-xl" : "relative bg-white/90 shadow-md"
                }
                style={{
                  zIndex: featured ? 3 : 2,
                  border: featured ? "2px solid #635bff" : `1px solid ${COLORS.cardBorder}`,
                  borderRadius: s(18, scale),
                  boxShadow: featured
                    ? "0 24px 42px rgba(99, 91, 255, 0.2)"
                    : "0 10px 18px rgba(15, 23, 42, 0.07)",
                  width: featured ? s(294, scale) : s(254, scale),
                  gap: s(14, scale),
                  marginTop: featured ? 0 : s(34, scale),
                  marginLeft: index === 0 ? 0 : s(-28, scale),
                  marginRight: index === 2 ? 0 : s(-28, scale),
                  transform: featured ? "scale(1.04)" : "scale(0.98)",
                }}
              >
                <CardContent
                  className="px-0"
                  style={{
                    paddingTop: s(22, scale),
                    paddingLeft: s(22, scale),
                    paddingRight: s(22, scale),
                    paddingBottom: s(20, scale),
                  }}
                >
                  <div
                    className="font-black leading-none text-slate-900"
                    style={{
                      fontSize: s(38, scale),
                      lineHeight: 1,
                    }}
                  >
                    {featured ? "$99" : "$29"}
                  </div>
                  <div className="mt-6 grid" style={{ marginTop: s(22, scale), gap: s(12, scale) }}>
                    <div
                      className="rounded-md bg-slate-200"
                      style={{
                        height: s(14, scale),
                        width: "92%",
                        borderRadius: s(6, scale),
                      }}
                    />
                    <div
                      className="rounded-md bg-slate-200"
                      style={{
                        height: s(14, scale),
                        width: "88%",
                        borderRadius: s(6, scale),
                      }}
                    />
                    <div
                      className="rounded-md bg-slate-200"
                      style={{
                        height: s(14, scale),
                        width: "81%",
                        borderRadius: s(6, scale),
                      }}
                    />
                    <div
                      className="rounded-md bg-slate-200"
                      style={{
                        height: s(14, scale),
                        width: "86%",
                        borderRadius: s(6, scale),
                      }}
                    />
                  </div>
                  <Button
                    className="w-full border-0 text-white"
                    style={{
                      marginTop: s(30, scale),
                      height: s(44, scale),
                      width: "100%",
                      borderRadius: s(10, scale),
                      background: featured ? COLORS.stripe : "#0f172a",
                      fontSize: s(16, scale),
                      fontWeight: 800,
                    }}
                  >
                    Subscribe
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
}

function Scene5() {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const scale = getScale(width, height);

  const first = fadeSlideUp({ frame, fps, delay: 0, durationInFrames: 20, variant: "soft", scale });

  return (
    <AbsoluteFill style={{ padding: s(92, scale), fontFamily: FONT_FAMILY }}>
      <div
        className="font-extrabold leading-tight text-slate-900"
        style={{
          ...first,
          marginTop: s(106, scale),
          fontSize: s(54, scale),
          lineHeight: 1.12,
          maxWidth: s(1660, scale),
        }}
      >
        No templates or starter kits, build quickly in your preferred stack.
      </div>
    </AbsoluteFill>
  );
}

export function FragnoOverviewVideo(_props: FragnoOverviewVideoProps) {
  return (
    <AbsoluteFill className="bg-slate-50">
      <BackgroundFrame />

      <Sequence from={FRAME.scene1} durationInFrames={SCENE_1_DURATION} premountFor={15}>
        <Scene1 />
      </Sequence>

      <Sequence from={FRAME.scene2} durationInFrames={SCENE_2_DURATION} premountFor={15}>
        <Scene2 />
      </Sequence>

      <Sequence from={FRAME.scene3} durationInFrames={SCENE_3_DURATION} premountFor={15}>
        <Scene3 />
      </Sequence>

      <Sequence from={FRAME.scene4} durationInFrames={SCENE_4_DURATION} premountFor={15}>
        <Scene4 />
      </Sequence>

      <Sequence from={FRAME.scene5} durationInFrames={SCENE_5_DURATION} premountFor={15}>
        <Scene5 />
      </Sequence>
    </AbsoluteFill>
  );
}
