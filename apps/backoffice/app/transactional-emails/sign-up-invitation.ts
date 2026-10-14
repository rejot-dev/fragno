import type { ResendSendEmailInput } from "@fragno-dev/resend-fragment";

const escapeHtmlAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

export type SignUpInvitationEmailInput = {
  email: string;
  invitationUrl: string;
  ttlDays: number;
};

export const buildSignUpInvitationEmail = ({
  email,
  invitationUrl,
  ttlDays,
}: SignUpInvitationEmailInput): ResendSendEmailInput => {
  const htmlInvitationUrl = escapeHtmlAttribute(invitationUrl);
  const expiryDescription = `This invitation expires in ${ttlDays} ${ttlDays === 1 ? "day" : "days"} and only works for ${email}.`;

  return {
    to: email,
    subject: "You're invited to Backoffice",
    text: [
      "You're invited to Backoffice.",
      "",
      "Use this link to create your account:",
      invitationUrl,
      "",
      expiryDescription,
    ].join("\n"),
    html: [
      '<div style="background:#f4f7f6;padding:32px 16px;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#10201b">',
      '<div style="max-width:560px;margin:0 auto;border:1px solid #cbd8d3;background:#ffffff;padding:32px">',
      '<p style="margin:0 0 12px;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#477064">Backoffice</p>',
      '<h1 style="margin:0 0 16px;font-size:28px;line-height:1.2">You\'re invited.</h1>',
      '<p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#345047">Create your Backoffice account to get started.</p>',
      `<a href="${htmlInvitationUrl}" style="display:inline-block;background:#163f34;color:#ffffff;padding:12px 18px;font-size:13px;font-weight:700;letter-spacing:.08em;text-decoration:none;text-transform:uppercase">Create account</a>`,
      `<p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#607c73">${expiryDescription}</p>`,
      "</div>",
      "</div>",
    ].join(""),
    tags: [
      { name: "category", value: "transactional" },
      { name: "event", value: "sign-up-invitation" },
    ],
  };
};
