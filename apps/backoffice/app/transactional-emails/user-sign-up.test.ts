import { assert, describe, expect, test } from "vitest";

import { buildUserSignUpVerificationEmail } from "./user-sign-up";

describe("user signup transactional email", () => {
  test("includes the email verification link in text and HTML", () => {
    const verificationUrl =
      "https://backoffice.example/backoffice/verify-email?userId=user_123&code=ABC12345";
    const email = buildUserSignUpVerificationEmail({
      email: "new-user@example.com",
      verificationUrl,
      expiresInHours: 48,
    });

    expect(email).toMatchObject({
      to: "new-user@example.com",
      subject: "Verify your email for Fragno Backoffice",
      tags: [
        { name: "category", value: "transactional" },
        { name: "event", value: "user-sign-up" },
      ],
    });
    assert(email.text?.includes(verificationUrl));
    assert(email.html?.includes("userId=user_123&amp;code=ABC12345"));
    expect(email.text).toContain("expires in 48 hours");
  });
});
