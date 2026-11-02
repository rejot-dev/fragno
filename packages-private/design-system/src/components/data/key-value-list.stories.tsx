import { KeyValueList } from "./key-value-list";

export default { title: "Data/Key-value list" };

const items = [
  { key: "environment", label: "Environment", value: "Production" },
  { key: "region", label: "Region", value: "us-east-1" },
  { key: "endpoint", label: "Endpoint", value: "https://api.example.com/v2/webhooks/deliveries" },
  { key: "owner", label: "Owner", value: "Platform team" },
];

export function TwoColumns() {
  return (
    <div className="max-w-2xl">
      <KeyValueList columns={2} items={items} />
    </div>
  );
}

export function OneColumn() {
  return (
    <div className="max-w-sm">
      <KeyValueList columns={1} items={items} />
    </div>
  );
}
