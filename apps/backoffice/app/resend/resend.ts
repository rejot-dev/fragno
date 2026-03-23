export interface SendEmailParams {
  to: string[];
  subject: string;
  html: string;
}

export interface ResendOptions {
  apiKey: string;
}

export type SendEmailResult =
  | {
      type: "ok";
      data: {
        id: string;
      };
    }
  | {
      type: "error";
      error: {
        message: string;
        code: string;
        data: string;
      };
    };

export async function sendEmail(
  { to, subject, html }: SendEmailParams,
  { apiKey }: ResendOptions,
): Promise<SendEmailResult> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },

    body: JSON.stringify({
      from: "Fragno <fragno@rejot.dev>",
      to,
      subject,
      html,
    }),
  });

  if (!res.ok) {
    return {
      type: "error",
      error: {
        message: "Failed to send email",
        code: "FAILED_TO_SEND_EMAIL",
        data: await res.text(),
      },
    };
  }

  const data = (await res.json()) as { id: string };

  return {
    type: "ok",
    data,
  };
}
