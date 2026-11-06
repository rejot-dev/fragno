import { assert, describe, test } from "vitest";

import { inboundEmailSenderDomain, inboundEmailSenderVerified } from "./inbound-email";

describe("inboundEmailSenderDomain", () => {
  test("reads the domain of the From address, lowercased", () => {
    assert(inboundEmailSenderDomain("Shop <Orders@Shop.example>") === "shop.example");
    assert(inboundEmailSenderDomain("orders@mail.shop.example") === "mail.shop.example");
  });

  test("reads the address, not a display name that looks like one", () => {
    assert(
      inboundEmailSenderDomain('"billing@shop.example" <x@attacker.test>') === "attacker.test",
    );
  });

  test("is null when From names no address", () => {
    assert(inboundEmailSenderDomain("Shop") === null);
    assert(inboundEmailSenderDomain("Shop <orders@>") === null);
  });
});

describe("inboundEmailSenderVerified", () => {
  test("trusts a DKIM signature by the From domain or a DMARC pass", () => {
    assert(inboundEmailSenderVerified({ spf: "fail", dkim: "pass", dmarc: "gray" }));
    assert(inboundEmailSenderVerified({ spf: "pass", dkim: "gray", dmarc: "pass" }));
  });

  test("does not trust SPF alone, which checks the envelope sender", () => {
    assert(!inboundEmailSenderVerified({ spf: "pass", dkim: "gray", dmarc: "gray" }));
  });

  test("does not trust a forged sender or email without results", () => {
    assert(!inboundEmailSenderVerified({ spf: "fail", dkim: "fail", dmarc: "fail" }));
    assert(!inboundEmailSenderVerified({ spf: "unknown", dkim: "unknown", dmarc: "unknown" }));
    assert(!inboundEmailSenderVerified(null));
  });
});
