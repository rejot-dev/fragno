import type { AppBranding } from "@fragno-dev/backoffice-api/v0/apps";
import {
  EmailCode,
  EmailParagraph,
  TransactionalEmail,
} from "@fragno-private/design-system/transactional-email";

import type { ResendSendEmailInput } from "@fragno-dev/resend-fragment";

import { render } from "@react-email/render";

type AppSignInCodeEmailProps = {
  email: string;
  code: string;
  expiresInMinutes: number;
  branding: AppBranding;
};

// The default export is what `pnpm email:dev` previews.
export default function AppSignInCodeEmail({
  code,
  expiresInMinutes,
  branding,
}: AppSignInCodeEmailProps) {
  return (
    <TransactionalEmail
      preview={`Your ${branding.displayName} code is ${code}.`}
      heading={`Your ${branding.displayName} code`}
      brand={{
        kind: "app",
        name: branding.displayName,
        homeUrl: branding.homeUrl,
        accentColor: branding.accentColor,
      }}
      reason={`You received this email because someone entered this address to sign in to ${branding.displayName}. If that was not you, you can ignore it.`}
    >
      <EmailParagraph>Enter this code to continue to {branding.displayName}.</EmailParagraph>
      <EmailCode code={code} />
      <EmailParagraph>
        It works once and expires in {expiresInMinutes} minutes. Never share it with anyone.
      </EmailParagraph>
    </TransactionalEmail>
  );
}

AppSignInCodeEmail.PreviewProps = {
  email: "ada@example.com",
  code: "482913",
  expiresInMinutes: 10,
  branding: {
    displayName: "Bookkeeping",
    logoUrl: "https://bookkeeping.example/logo.svg",
    accentColor: "#c2560a",
    homeUrl: "https://bookkeeping.example",
    supportUrl: "https://bookkeeping.example/help",
  },
} satisfies AppSignInCodeEmailProps;

export async function buildAppSignInCodeEmail(
  props: AppSignInCodeEmailProps,
): Promise<ResendSendEmailInput> {
  const message = <AppSignInCodeEmail {...props} />;
  return {
    to: props.email,
    subject: `Your ${props.branding.displayName} code: ${props.code}`,
    html: await render(message),
    text: await render(message, { plainText: true }),
    tags: [
      { name: "category", value: "transactional" },
      { name: "event", value: "app-sign-in-code" },
    ],
  };
}
