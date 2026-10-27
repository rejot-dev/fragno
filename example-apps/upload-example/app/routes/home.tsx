import { UploadPanel } from "~/components/upload-panel";
import { uploadClient } from "~/uploads/upload-client";

export function meta() {
  return [
    { title: "Upload Fragment Example" },
    { name: "description", content: "Fragno upload fragment demo" },
  ];
}

export default function Home() {
  return (
    <UploadPanel
      title="Database-backed uploads"
      description="Files stream through the server into the app's database. Each upload stores its content and publishes the file in one transaction."
      client={uploadClient}
      defaultCollection="files"
      defaultProvider="files"
      accent="emerald"
    />
  );
}
