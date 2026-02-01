import { UploadPanel } from "~/components/upload-panel";
import { directUploadClient } from "~/uploads/upload-client";

export function meta() {
  return [
    { title: "S3-backed Storage Uploads" },
    { name: "description", content: "Multipart uploads to S3-compatible storage" },
  ];
}

export default function DirectUploads() {
  return (
    <UploadPanel
      title="S3-backed storage uploads"
      description="Upload files directly to S3-compatible storage. Configure UPLOAD_S3_* env vars, then the client helper handles multipart splitting, progress updates, and completion."
      client={directUploadClient}
      defaultCollection="direct"
      accent="amber"
    />
  );
}
