# Infra

Leyway's Cloudflare infrastructure as code, managed with [Pulumi](https://www.pulumi.com/). For now
it defines the alerts that tell us Leyway is broken. The Workers themselves are still configured by
their Wrangler files and deployed with Wrangler.

## How it is set up

| Part           | Where                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------- |
| Pulumi project | `Pulumi.yaml`: project `leyway-infra`, a Node.js program in `src/index.ts`                          |
| Stack          | `prod`, the only one. Its config is in `Pulumi.prod.yaml`                                           |
| State          | The `leyway-pulumi-state` R2 bucket on the ReJot account, through R2's S3 API                       |
| Secrets        | Encrypted in the state with a passphrase (`PULUMI_CONFIG_PASSPHRASE`)                               |
| Cloudflare     | The ReJot account (`cda934461b3c3f24b4899fc8a100ffe6`), through `@pulumi/cloudflare`                |
| Deploys        | Locally with `pnpm apply`, and by the [Infra workflow](../../.github/workflows/infra.yml) on `main` |

Some things that are not obvious:

- **The state bucket is not managed by Pulumi.** It was created by hand, since a stack cannot keep
  its state in a bucket it manages itself. Its URL is `backend.url` in `Pulumi.yaml`.
- **Pulumi runs the TypeScript directly.** `typescript: false` in `Pulumi.yaml` makes Pulumi hand
  `src/index.ts` to Node, which strips the types. `pnpm types:check` is the only type check.
- **Pulumi always runs through `scripts/pulumi.ts`.** Pulumi reads the state bucket through R2's S3
  API, which takes S3 keys instead of an API token. R2
  [derives them from the token](https://developers.cloudflare.com/r2/api/tokens/#get-s3-api-credentials-from-an-api-token),
  so the script computes `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from `CLOUDFLARE_API_TOKEN`
  and then runs the CLI. Run Pulumi commands with `pnpm pulumi <command>` instead of `pulumi`.
- **Some alerts bypass the Cloudflare provider.** `cloudflare.NotificationPolicy` only accepts the
  alert types its provider was generated with. `RawNotificationPolicy`
  (`src/raw-notification-policy.ts`) is a
  [dynamic resource](https://www.pulumi.com/docs/iac/concepts/resources/dynamic-providers/) that
  manages newer types through the Cloudflare API instead, with the same `CLOUDFLARE_API_TOKEN`.

## Alerts

All alerts email the addresses in `alertEmails` in `Pulumi.prod.yaml`.

- **New Worker issue** (`workers_observability_real_time_issue`):
  [Workers Issues](https://developers.cloudflare.com/workers/observability/issues/) detected a new
  failure in `rejot-backoffice`, `rejot-backoffice-web` or `cf-sandbox-bridge`. This alert type
  cannot be filtered: it covers every Worker that sets `observability.issues.enabled` in its
  Wrangler config, so only Leyway's Workers should turn that on.
- **Cloudflare incident** (`incident_alert`): a major or critical Cloudflare incident affects
  Workers, Durable Objects, R2 or Workers AI.
- **Test alert**: never fires on its own. Fire it to check that alerts reach us:

  ```sh
  curl -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/cda934461b3c3f24b4899fc8a100ffe6/alerting/v3/policies/$(pnpm --silent pulumi stack output testAlertPolicyId --stack prod)/test"
  ```

Our zones are on the Free plan, so HTTP error-rate alerts and Health Checks are not available.

## Running it locally

Everyone runs Pulumi with their own Cloudflare API token, so changes show up under their name in the
audit log. One token covers both the Cloudflare API and the state bucket:

| Resource | Permission                     | Access                                    |
| -------- | ------------------------------ | ----------------------------------------- |
| Account  | Notifications                  | Edit                                      |
| Account  | Workers R2 Storage Bucket Item | Edit, on the `leyway-pulumi-state` bucket |

1. Install the Pulumi CLI: `brew install pulumi`.
2. Create the token under **My Profile → API Tokens → Create Custom Token**, with the permissions
   above on the ReJot account.
3. Get `PULUMI_CONFIG_PASSPHRASE` from the password manager.
4. Put `CLOUDFLARE_API_TOKEN` and `PULUMI_CONFIG_PASSPHRASE` in `apps/infra/.env`, which Git
   ignores. The package scripts load it.
5. Preview and apply: `pnpm preview`, then `pnpm apply`.

## Deploys

The [Infra workflow](../../.github/workflows/infra.yml) runs `pnpm apply` on the `prod` stack when a
change to `apps/infra` lands on `main`, and can be started by hand from the Actions tab. It reads
these repository secrets:

- `INFRA_CLOUDFLARE_API_TOKEN`: a Cloudflare API token with the permissions in
  [Running it locally](#running-it-locally).
- `INFRA_PULUMI_CONFIG_PASSPHRASE`: the stack passphrase.

> [!WARNING]
>
> `INFRA_CLOUDFLARE_API_TOKEN` is currently Niklas's personal API token. Replace it with a dedicated
> account-owned token (**Manage Account → Account API Tokens**), so deploys do not break when that
> token is rolled or its owner leaves the account.

## Adding resources

Add resources to `src/index.ts`. When a new resource type needs a permission the tokens lack,
`pnpm preview` fails with a permission error. Add that permission to your own token and to the one
in `INFRA_CLOUDFLARE_API_TOKEN`, and list it in the table above.
