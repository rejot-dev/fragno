import { SourceConnectionsList } from "~/components/SourceConnectionsList";
import { Layout } from "~/components/Layout";

export default function Connections(): React.JSX.Element {
  return (
    <Layout activeTab="connections">
      <SourceConnectionsList />
    </Layout>
  );
}
