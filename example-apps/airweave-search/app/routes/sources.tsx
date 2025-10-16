import { SourcesList } from "~/components/SourcesList";
import { Layout } from "~/components/Layout";

export default function Sources(): React.JSX.Element {
  return (
    <Layout activeTab="sources">
      <SourcesList />
    </Layout>
  );
}
