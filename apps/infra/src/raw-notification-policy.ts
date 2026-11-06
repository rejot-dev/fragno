import * as pulumi from "@pulumi/pulumi";

// `cloudflare.NotificationPolicy` only accepts the alert types its provider was generated with, so
// this manages newer ones, such as `workers_observability_real_time_issue`, through the API.

interface RawNotificationPolicyInputs {
  accountId: string;
  name: string;
  description: string;
  alertType: string;
  emails: string[];
}

type RawNotificationPolicyArgs = {
  [K in keyof RawNotificationPolicyInputs]: pulumi.Input<RawNotificationPolicyInputs[K]>;
};

async function requestPolicies(
  method: "POST" | "PUT" | "DELETE",
  accountId: string,
  path: string,
  inputs: RawNotificationPolicyInputs | undefined,
): Promise<{ id: string }> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/alerting/v3/policies${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${process.env["CLOUDFLARE_API_TOKEN"]}`,
        "content-type": "application/json",
      },
      body:
        inputs &&
        JSON.stringify({
          name: inputs.name,
          description: inputs.description,
          alert_type: inputs.alertType,
          enabled: true,
          filters: {},
          mechanisms: { email: inputs.emails.map((id) => ({ id })) },
        }),
    },
  );
  const envelope = (await response.json()) as {
    success: boolean;
    errors: unknown[];
    result: { id: string };
  };
  if (!envelope.success) {
    throw new Error(`${method} notification policy failed: ${JSON.stringify(envelope.errors)}`);
  }
  return envelope.result;
}

// Pulumi serializes the provider, and the functions it calls, into the stack's state.
const provider: pulumi.dynamic.ResourceProvider<
  RawNotificationPolicyInputs,
  RawNotificationPolicyInputs
> = {
  async create(inputs) {
    const result = await requestPolicies("POST", inputs.accountId, "", inputs);
    return { id: result.id, outs: inputs };
  },
  async update(id, _olds, news) {
    await requestPolicies("PUT", news.accountId, `/${id}`, news);
    return { outs: news };
  },
  async delete(id, props) {
    await requestPolicies("DELETE", props.accountId, `/${id}`, undefined);
  },
};

export class RawNotificationPolicy extends pulumi.dynamic.Resource {
  constructor(name: string, args: RawNotificationPolicyArgs) {
    super(provider, name, args);
  }
}
