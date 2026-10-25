import { DetailList } from "./detail-list";

export default { title: "Data/Detail list" };

export function Default() {
  return (
    <div className="max-w-xl">
      <DetailList
        items={[
          {
            key: "webhook",
            label: "Webhook URL",
            value: (
              <span className="font-mono">https://backoffice.example/api/github/webhooks</span>
            ),
          },
          { key: "scopes", label: "OAuth scopes", value: "openid, offline_access, backoffice" },
          { key: "approved", label: "Last approved", value: "Oct 23, 2026, 8:44 AM UTC" },
        ]}
      />
    </div>
  );
}
