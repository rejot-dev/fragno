import type { AppBranding } from "@fragno-dev/backoffice-api/v0/apps";
import {
  EmailButton,
  EmailFootnote,
  EmailParagraph,
  TransactionalEmail,
} from "@fragno-private/design-system/transactional-email";

import type { ResendSendEmailInput } from "@fragno-dev/resend-fragment";

import { render } from "@react-email/render";

type AppInvitationEmailProps = {
  email: string;
  organizationName: string;
  inviterName: string;
  /** The app's page where the invitation is accepted. */
  invitationUrl: string;
  expiresInDays: number;
  branding: AppBranding;
};

// The default export is what `pnpm email:dev` previews.
export default function AppInvitationEmail({
  email,
  organizationName,
  inviterName,
  invitationUrl,
  expiresInDays,
  branding,
}: AppInvitationEmailProps) {
  return (
    <TransactionalEmail
      preview={`${inviterName} invited you to ${organizationName} on ${branding.displayName}.`}
      heading={`Join ${organizationName}`}
      brand={{
        kind: "app",
        name: branding.displayName,
        homeUrl: branding.homeUrl,
        accentColor: branding.accentColor,
      }}
      reason={`You received this email because ${inviterName} invited this address to ${organizationName} on ${branding.displayName}. If you were not expecting it, you can ignore it.`}
    >
      <EmailParagraph>
        {inviterName} invited you to join {organizationName} on {branding.displayName}.
      </EmailParagraph>
      <EmailButton href={invitationUrl}>Accept invitation</EmailButton>
      <EmailFootnote href={invitationUrl}>
        This invitation expires in {expiresInDays} {expiresInDays === 1 ? "day" : "days"} and only
        works for {email}.
      </EmailFootnote>
    </TransactionalEmail>
  );
}

AppInvitationEmail.PreviewProps = {
  email: "charles@example.com",
  organizationName: "Analytical Engines",
  inviterName: "Ada Lovelace",
  invitationUrl: "https://bookkeeping.example/invitations/inv_123",
  expiresInDays: 2,
  branding: {
    displayName: "Bookkeeping",
    logoUrl: "https://bookkeeping.example/logo.svg",
    accentColor: "#c2560a",
    homeUrl: "https://bookkeeping.example",
    supportUrl: "https://bookkeeping.example/help",
  },
} satisfies AppInvitationEmailProps;

export async function buildAppInvitationEmail(
  props: AppInvitationEmailProps,
): Promise<ResendSendEmailInput> {
  const message = <AppInvitationEmail {...props} />;
  return {
    to: props.email,
    subject: `${props.inviterName} invited you to ${props.organizationName} on ${props.branding.displayName}`,
    html: await render(message),
    text: await render(message, { plainText: true }),
    tags: [
      { name: "category", value: "transactional" },
      { name: "event", value: "app-invitation" },
    ],
  };
}
