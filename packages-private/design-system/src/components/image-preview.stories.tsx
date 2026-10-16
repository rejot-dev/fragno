import { Button } from "./button";
import { ImagePreview } from "./image-preview";
import { ImagePreviewCard } from "./image-preview-card";

export default { title: "Data/Image preview" };

// Inline so the stories render offline.
const SAMPLE_IMAGE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#e8eaf8"/><rect x="24" y="24" width="120" height="132" fill="#1e2fb0"/><rect x="164" y="24" width="132" height="60" fill="#9aa1db"/><rect x="164" y="96" width="132" height="60" fill="#12856f"/></svg>',
)}`;

export function Preview() {
  return (
    <div className="flex flex-wrap items-start gap-6">
      <ImagePreview src={SAMPLE_IMAGE} alt="Quarterly layout sketch" />
      <ImagePreview src={null} alt="Missing receipt" />
      <ImagePreview src="https://invalid.example/broken.png" alt="Broken link" />
    </div>
  );
}

export function Card() {
  return (
    <ImagePreviewCard
      src={SAMPLE_IMAGE}
      alt="Quarterly layout sketch"
      filename="quarterly-layout-sketch.svg"
      action={<Button variant="ghost">Download</Button>}
    />
  );
}
