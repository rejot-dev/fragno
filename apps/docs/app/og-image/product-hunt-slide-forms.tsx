import {
  OG_CARD,
  OG_CODE_BLOCK,
  OG_LABEL,
  OG_LAYOUT,
  OG_LIST,
  OG_TITLE,
  OgSlideFrame,
} from "./slide-frame";

export function ProductHuntSlideForms() {
  return (
    <OgSlideFrame>
      <div className={OG_LAYOUT}>
        <h1 className={OG_TITLE}>
          <span className="bg-linear-to-r from-blue-600 to-blue-500 bg-clip-text text-transparent dark:from-blue-300 dark:to-blue-500">
            Forms
          </span>{" "}
          Fragment
        </h1>

        <div className="mt-8 grid grid-cols-2 gap-5">
          <div className={OG_CARD}>
            <p className={OG_LABEL}>Data Model</p>
            <ul className={OG_LIST}>
              <li>JSON Schema for validation</li>
              <li>JSONForms UI Schema for layout</li>
              <li>Portable schema format</li>
            </ul>
          </div>

          <div className={OG_CARD}>
            <p className={OG_LABEL}>Runtime</p>
            <ul className={OG_LIST}>
              <li>Render with your component system</li>
              <li>shadcn renderer available</li>
              <li>Responses stored in your database</li>
            </ul>
          </div>
        </div>

        <div className={`mt-5 ${OG_CODE_BLOCK}`}>npm install @fragno-dev/forms @fragno-dev/db</div>
      </div>
    </OgSlideFrame>
  );
}
