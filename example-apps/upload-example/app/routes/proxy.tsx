import { UploadPanel } from "~/components/upload-panel";
import { proxyUploadClient } from "~/uploads/upload-client";

export function meta() {
  return [
    { title: "File Storage Uploads" },
    { name: "description", content: "Streaming uploads to filesystem storage" },
  ];
}

export default function ProxyUploads() {
  return (
    <UploadPanel
      title="File storage uploads"
      description="Stream files through the server to the filesystem adapter. This is a great default for local development."
      client={proxyUploadClient}
      defaultCollection="proxy"
      accent="emerald"
    />
  );
}
