# Webhook Contract

How to fill a webhook's `auth` and `verification` from a provider's documentation. The setup check's
`inputSchema` is the authoritative shape.

## Signatures

A “webhook secret,” “signing secret,” or a secret-shaped value is an HMAC clue; bearer applies only
when the provider sends `Authorization: Bearer ...`. Fill HMAC from the documentation:

- `algorithm`: `sha1`, `sha256`, or `sha512`.
- `signature.location` and `signature.name`: the exact header or query parameter.
- `signature.encoding`: `hex`, `base64`, or `base64url`. A hex digest in the provider's own
  verification code means `hex`.
- `signature.prefix`: the text before the encoded signature, such as `sha256=`; omit it when there
  is none.
- `signedPayload`: `rawBody` when the provider signs the unmodified body; `timestampedBody` when it
  signs a prefix, a timestamp header, a delimiter, and the body. Copy `prefix`, `timestampHeader`,
  and `delimiter` exactly, and use the provider's replay window as `toleranceSeconds`.

## Challenges

A challenge is a request the provider sends when the URL is entered and expects echoed back.
Configure the exact HTTP `method`, a `when` predicate (`present`, or `equals` a fixed value) on a
header, query parameter, or JSON body path, and the `response` value to echo.

## Slack

Slack challenges on entry and signs a timestamped body:

```js
const contract = {
  name: "Slack",
  verification: {
    type: "challenge",
    method: "POST",
    when: {
      type: "equals",
      source: { type: "jsonBodyPath", path: ["type"] },
      value: "url_verification",
    },
    response: { type: "echoText", source: { type: "jsonBodyPath", path: ["challenge"] } },
  },
  deliveryIdentity: { type: "jsonBodyPath", path: ["event_id"] },
  auth: {
    type: "hmac",
    secret: signingSecret,
    algorithm: "sha256",
    signature: { location: "header", name: "x-slack-signature", encoding: "hex", prefix: "v0=" },
    signedPayload: {
      type: "timestampedBody",
      prefix: "v0:",
      timestampHeader: "x-slack-request-timestamp",
      delimiter: ":",
      toleranceSeconds: 300,
    },
  },
};
```
