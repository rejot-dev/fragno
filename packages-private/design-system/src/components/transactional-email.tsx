import { createContext, use, type ReactNode } from "react";
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "react-email";

// Email clients resolve neither CSS custom properties nor oklch(), and many strip <style>, so
// emails inline these hex values. They mirror the light tokens in theme.css and must change with
// them. Emails stay light because dark-mode selectors are not reliably supported by email clients.
const PALETTE = {
  background: "#fbf9f8",
  panel: "#ffffff",
  border: "#ece9e6",
  foreground: "#25211c",
  muted: "#56647a",
  muted2: "#7a889d",
  primary: "#c2560a",
  primaryForeground: "#ffffff",
  live: "#12856f",
  waiting: "#a7650c",
  // The fragment mark's third square: --bo-accent at 45% opacity, flattened onto the panel.
  primaryFaded: "#9aa1db",
};

// Mirrors --font-sans. Most clients do not load web fonts, so recipients without Plus Jakarta Sans
// installed see the system font.
const FONT_SANS =
  '"Plus Jakarta Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/**
 * Whose message it is: Backoffice's, or an app's that Backoffice sends in its name. An app's email
 * names only the app, plus a small "Secured by ReJot" line, because its recipients may not know
 * Backoffice.
 */
export type TransactionalEmailBrand =
  | { kind: "backoffice"; homeUrl: string }
  | { kind: "app"; name: string; homeUrl: string; accentColor: string };

// The brand's color for calls to action: an app's accent, or Backoffice's primary.
const AccentColor = createContext(PALETTE.primary);

// A branded message: the brand header, one heading and the body on a panel like a FormContainer,
// and the brand footer. `preview` is the inbox snippet shown next to the subject; `reason` tells the
// recipient why they received the email, and the footer links to the brand's home.
export function TransactionalEmail({
  preview,
  heading,
  reason,
  brand,
  children,
}: {
  preview: string;
  heading: string;
  reason: string;
  brand: TransactionalEmailBrand;
  children: ReactNode;
}) {
  return (
    <Html lang="en">
      <Head>
        {/* Keeps clients that auto-darken from inverting the light palette. */}
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Body
        style={{
          margin: 0,
          backgroundColor: PALETTE.background,
          padding: "32px 16px",
          fontFamily: FONT_SANS,
          color: PALETTE.foreground,
        }}
      >
        <Preview>{preview}</Preview>
        <Container style={{ maxWidth: "560px" }}>
          {brand.kind === "backoffice" ? <EmailHeader /> : <AppEmailHeader brand={brand} />}
          <Section
            style={{
              border: `1px solid ${PALETTE.border}`,
              borderRadius: "6px",
              backgroundColor: PALETTE.panel,
              padding: "32px",
            }}
          >
            <Heading
              as="h1"
              style={{
                margin: "0 0 12px",
                fontSize: "24px",
                lineHeight: "32px",
                fontWeight: 600,
                color: PALETTE.foreground,
              }}
            >
              {heading}
            </Heading>
            <AccentColor value={brand.kind === "app" ? brand.accentColor : PALETTE.primary}>
              {children}
            </AccentColor>
          </Section>
          {brand.kind === "backoffice" ? (
            <EmailFooter reason={reason} homeUrl={brand.homeUrl} />
          ) : (
            <AppEmailFooter reason={reason} brand={brand} />
          )}
        </Container>
      </Body>
    </Html>
  );
}

// Mirrors LandingHeader: the fragment mark beside the uppercase product name.
function EmailHeader() {
  return (
    <Section style={{ paddingBottom: "20px" }}>
      <table role="presentation" cellPadding={0} cellSpacing={0} border={0}>
        <tbody>
          <tr>
            <td style={{ verticalAlign: "middle" }}>
              <FragmentMark />
            </td>
            <td
              style={{
                verticalAlign: "middle",
                paddingLeft: "12px",
                fontSize: "10px",
                lineHeight: "18px",
                fontWeight: 700,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                color: PALETTE.foreground,
              }}
            >
              ReJot Backoffice
            </td>
          </tr>
        </tbody>
      </table>
    </Section>
  );
}

// The app's name in its accent color. Text, not the app's logo: many clients block images.
function AppEmailHeader({ brand }: { brand: Extract<TransactionalEmailBrand, { kind: "app" }> }) {
  return (
    <Section style={{ paddingBottom: "20px" }}>
      <Text
        style={{
          margin: 0,
          fontSize: "18px",
          lineHeight: "24px",
          fontWeight: 700,
          color: brand.accentColor,
        }}
      >
        {brand.name}
      </Text>
    </Section>
  );
}

// BackofficeFragmentMark at its md size, drawn as table cells because the CSS grid it uses in the
// app does not survive email clients, and an image would be blocked by default in many of them.
function FragmentMark() {
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} border={0}>
      <tbody>
        <tr>
          <MarkSquare color={PALETTE.primary} />
          <MarkGap />
          <MarkSquare color={PALETTE.live} />
        </tr>
        <tr>
          <MarkGap />
        </tr>
        <tr>
          <MarkSquare color={PALETTE.primaryFaded} />
          <MarkGap />
          <MarkSquare color={PALETTE.waiting} />
        </tr>
      </tbody>
    </table>
  );
}

// Zero font size and line height stop clients like Outlook from growing empty cells to a line box.
function MarkSquare({ color }: { color: string }) {
  return (
    <td
      width={8}
      height={8}
      style={{ width: "8px", height: "8px", backgroundColor: color, fontSize: 0, lineHeight: 0 }}
    />
  );
}

function MarkGap() {
  return (
    <td width={2} height={2} style={{ width: "2px", height: "2px", fontSize: 0, lineHeight: 0 }} />
  );
}

// Mirrors LandingFooter's brand block, preceded by why the recipient received the email.
function EmailFooter({ reason, homeUrl }: { reason: string; homeUrl: string }) {
  return (
    <Section style={{ paddingTop: "24px" }}>
      <Text
        style={{ margin: "0 0 16px", fontSize: "12px", lineHeight: "20px", color: PALETTE.muted }}
      >
        {reason}
      </Text>
      <Text
        style={{
          margin: "0 0 4px",
          fontSize: "10px",
          lineHeight: "16px",
          fontWeight: 700,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: PALETTE.foreground,
        }}
      >
        Backoffice by ReJot
      </Text>
      <Text style={{ margin: 0, fontSize: "11px", lineHeight: "20px", color: PALETTE.muted }}>
        A controlled workspace for AI workflows.
      </Text>
      <Text style={{ margin: 0, fontSize: "11px", lineHeight: "20px" }}>
        <Link href={homeUrl} style={{ color: PALETTE.primary }}>
          {new URL(homeUrl).host}
        </Link>
      </Text>
    </Section>
  );
}

function AppEmailFooter({
  reason,
  brand,
}: {
  reason: string;
  brand: Extract<TransactionalEmailBrand, { kind: "app" }>;
}) {
  return (
    <Section style={{ paddingTop: "24px" }}>
      <Text
        style={{ margin: "0 0 16px", fontSize: "12px", lineHeight: "20px", color: PALETTE.muted }}
      >
        {reason}
      </Text>
      <Text style={{ margin: 0, fontSize: "11px", lineHeight: "20px" }}>
        <Link href={brand.homeUrl} style={{ color: brand.accentColor }}>
          {new URL(brand.homeUrl).host}
        </Link>
      </Text>
      <Text style={{ margin: 0, fontSize: "11px", lineHeight: "20px", color: PALETTE.muted2 }}>
        Secured by ReJot
      </Text>
    </Section>
  );
}

// A one-time code, large and spaced so it reads at a glance and copies as one word.
export function EmailCode({ code }: { code: string }) {
  return (
    <Text
      style={{
        margin: "0 0 24px",
        borderRadius: "6px",
        backgroundColor: PALETTE.background,
        padding: "16px",
        textAlign: "center",
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: "32px",
        lineHeight: "40px",
        fontWeight: 700,
        letterSpacing: "0.3em",
        color: PALETTE.foreground,
      }}
    >
      {code}
    </Text>
  );
}

export function EmailParagraph({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{ margin: "0 0 24px", fontSize: "16px", lineHeight: "24px", color: PALETTE.muted }}
    >
      {children}
    </Text>
  );
}

// The solid Button variant, in the brand's color: the email's single call to action.
export function EmailButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button
      href={href}
      style={{
        boxSizing: "border-box",
        borderRadius: "4px",
        backgroundColor: use(AccentColor),
        padding: "12px 16px",
        fontSize: "14px",
        lineHeight: "20px",
        fontWeight: 600,
        color: PALETTE.primaryForeground,
        textDecoration: "none",
      }}
    >
      {children}
    </Button>
  );
}

// Fine print below the call to action. Repeats `href` as plain text for clients that break the
// button, and puts it on its own line so the plain-text rendering does too.
export function EmailFootnote({ href, children }: { href: string; children: ReactNode }) {
  const accentColor = use(AccentColor);
  return (
    <Section
      style={{ marginTop: "32px", borderTop: `1px solid ${PALETTE.border}`, paddingTop: "16px" }}
    >
      <Text
        style={{ margin: "0 0 8px", fontSize: "13px", lineHeight: "20px", color: PALETTE.muted2 }}
      >
        {children}
      </Text>
      <Text style={{ margin: 0, fontSize: "13px", lineHeight: "20px", color: PALETTE.muted2 }}>
        If the button does not work, paste this link into your browser:
        <br />
        <Link href={href} style={{ color: accentColor, wordBreak: "break-all" }}>
          {href}
        </Link>
      </Text>
    </Section>
  );
}
