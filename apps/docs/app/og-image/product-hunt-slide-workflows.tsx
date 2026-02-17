import {
  OG_CARD,
  OG_CODE_BLOCK,
  OG_LABEL,
  OG_LAYOUT,
  OG_LIST,
  OG_TITLE,
  OgSlideFrame,
} from "./slide-frame";

export function ProductHuntSlideWorkflows() {
  return (
    <OgSlideFrame>
      <div className={OG_LAYOUT}>
        <h1 className={OG_TITLE}>
          <span className="bg-linear-to-r from-amber-600 to-amber-500 bg-clip-text text-transparent dark:from-amber-300 dark:to-amber-500">
            Workflows
          </span>{" "}
          Fragment
        </h1>

        <div className="mt-8 grid grid-cols-2 gap-5">
          <div className={OG_CARD}>
            <p className={OG_LABEL}>Runtime Features</p>
            <ul className={OG_LIST}>
              <li>Durable steps and retries</li>
              <li>Timers and event waits</li>
              <li>State persisted in your database</li>
            </ul>
          </div>

          <div className={OG_CARD}>
            <p className={OG_LABEL}>Interfaces</p>
            <ul className={OG_LIST}>
              <li>HTTP API for instances + events</li>
              <li>fragno-wf CLI for control + inspection</li>
              <li>Runner + dispatcher execution model</li>
            </ul>
          </div>
        </div>

        <div className={`mt-5 ${OG_CODE_BLOCK}`}>
          npm install @fragno-dev/workflows @fragno-dev/db
        </div>
      </div>
    </OgSlideFrame>
  );
}
