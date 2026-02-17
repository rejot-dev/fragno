import {
  OG_CARD,
  OG_CODE_BLOCK,
  OG_LABEL,
  OG_LAYOUT,
  OG_LIST,
  OG_TITLE,
  OgSlideFrame,
} from "./slide-frame";

export function ProductHuntSlideUpload() {
  return (
    <OgSlideFrame>
      <div className={OG_LAYOUT}>
        <h1 className={OG_TITLE}>
          <span className="bg-linear-to-r from-cyan-600 to-cyan-500 bg-clip-text text-transparent dark:from-cyan-300 dark:to-cyan-500">
            Upload
          </span>{" "}
          Fragment
        </h1>

        <div className="mt-8 grid grid-cols-2 gap-5">
          <div className={OG_CARD}>
            <p className={OG_LABEL}>Upload Modes</p>
            <ul className={OG_LIST}>
              <li>Direct signed URL uploads</li>
              <li>Server-streamed proxy uploads</li>
              <li>Progress + metadata records</li>
            </ul>
          </div>

          <div className={OG_CARD}>
            <p className={OG_LABEL}>Storage Adapters</p>
            <ul className={OG_LIST}>
              <li>S3-compatible (including R2)</li>
              <li>Cloudflare R2 adapter</li>
              <li>Filesystem adapter</li>
            </ul>
          </div>
        </div>

        <div className={`mt-5 ${OG_CODE_BLOCK}`}>npm install @fragno-dev/upload</div>
      </div>
    </OgSlideFrame>
  );
}
