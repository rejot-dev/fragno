import type { ResendSendEmailInput } from "@fragno-dev/resend-fragment";

export const buildUserSignUpEmail = (email: string): ResendSendEmailInput => ({
  to: email,
  subject: "Welcome to Fragno Backoffice",
  text: [
    "Welcome to Fragno Backoffice.",
    "",
    "Your account is ready. You can now sign in and start configuring your Fragno workspace.",
  ].join("\n"),
  html: [
    '<div style="background:#f4f7f6;padding:32px 16px;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#10201b">',
    '<div style="max-width:560px;margin:0 auto;border:1px solid #cbd8d3;background:#ffffff;padding:32px">',
    '<p style="margin:0 0 12px;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#477064">Fragno Backoffice</p>',
    '<h1 style="margin:0 0 16px;font-size:28px;line-height:1.2">Your account is ready.</h1>',
    '<p style="margin:0;font-size:16px;line-height:1.6;color:#345047">You can now sign in and start configuring your Fragno workspace.</p>',
    "</div>",
    "</div>",
  ].join(""),
  tags: [
    { name: "category", value: "transactional" },
    { name: "event", value: "user-sign-up" },
  ],
});
