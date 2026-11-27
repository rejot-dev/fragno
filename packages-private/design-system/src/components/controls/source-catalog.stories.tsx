import { ActionItem } from "./action-item";
import { SourceCatalog, type SourceCatalogItem } from "./source-catalog";

export default { title: "Controls/Source catalog" };

const communication = { id: "communication", label: "Communication" };
const developerTools = { id: "developer_tools", label: "Developer Tools" };
const productivity = { id: "productivity", label: "Productivity" };
const storage = { id: "storage", label: "Storage" };
const documents = { id: "documents", label: "Documents & Content" };
const popular = { id: "popular", label: "Popular" };
const connected = { id: "connected", label: "Connected" };
const LEADING_CATEGORY_IDS = [connected.id, popular.id];

function oomolLogo(name: string) {
  return { kind: "image" as const, url: `https://static.oomol.com/logo/third-party/${name}.svg` };
}

const ITEMS: SourceCatalogItem[] = [
  {
    id: "gmail",
    label: "Gmail",
    description: "Email conversations, labels, drafts, and mailbox management",
    icon: oomolLogo("Gmail"),
    categories: [connected, popular, communication, productivity],
    status: "Connected",
    to: "#gmail",
  },
  {
    id: "googledrive",
    label: "Google Drive",
    description: "Cloud file storage, organization, and document sharing",
    icon: oomolLogo("Google%20Drive"),
    categories: [storage, productivity, documents],
    status: null,
    to: "#googledrive",
  },
  {
    id: "linear",
    label: "Linear",
    description: "Product and engineering issue, project, and cycle management",
    icon: oomolLogo("Linear"),
    categories: [popular, productivity, developerTools],
    status: null,
    to: "#linear",
  },
  {
    id: "notion",
    label: "Notion",
    description: "Shared workspace for documents, pages, and databases",
    icon: oomolLogo("Notion"),
    categories: [productivity, documents],
    status: null,
    to: "#notion",
  },
  {
    id: "telegram",
    label: "Telegram",
    description: "A Telegram bot that receives chat messages and replies to them.",
    icon: { kind: "symbol", name: "send" },
    categories: [communication],
    status: null,
    to: "#telegram",
  },
  {
    id: "github",
    label: "GitHub",
    description: "Repositories, issues, and pull requests through a GitHub App installation.",
    icon: { kind: "symbol", name: "github" },
    categories: [developerTools],
    status: null,
    to: "#github",
  },
  {
    id: "webhook",
    label: "Inbound webhook",
    description: "A public URL that accepts a provider's webhook deliveries.",
    icon: { kind: "symbol", name: "zap" },
    categories: [developerTools],
    status: null,
    to: "#webhook",
  },
  {
    id: "custom",
    label: "Internal tool",
    description: "A source without categories is listed under Other.",
    icon: { kind: "symbol", name: "box" },
    categories: [],
    status: null,
    to: "#custom",
  },
];

export function Sources() {
  return (
    <div className="h-[560px] max-w-4xl overflow-y-auto">
      <SourceCatalog
        label="Sources to connect"
        items={ITEMS}
        leadingCategoryIds={LEADING_CATEGORY_IDS}
        expanded={null}
      />
    </div>
  );
}

export function ExpandedSource() {
  return (
    <div className="h-[560px] max-w-4xl overflow-y-auto">
      <SourceCatalog
        label="Sources to connect"
        items={ITEMS}
        leadingCategoryIds={LEADING_CATEGORY_IDS}
        expanded={{
          id: "gmail",
          content: (
            <div className="flex flex-col gap-3">
              <p className="text-xs leading-5 text-pretty text-[var(--bo-muted)]">
                Your agents can use Gmail now. Next, put it to work in a workflow.
              </p>
              <ActionItem icon="share-2" emphasis="primary">
                Create a workflow
              </ActionItem>
            </div>
          ),
        }}
      />
    </div>
  );
}
