import {
  OG_CODE_BLOCK,
  OG_LABEL,
  OG_LAYOUT,
  OG_SUBTITLE,
  OG_TITLE,
  OgSlideFrame,
} from "./slide-frame";

export function ProductHuntSlideSkill() {
  return (
    <OgSlideFrame>
      <div className={OG_LAYOUT}>
        <h1 className={OG_TITLE}>
          Get started with
          <br />
          the Fragno LLM Skill
        </h1>
        <p className={OG_SUBTITLE}>
          Install the skill once, then ask your assistant to integrate Fragno fragments into your
          app.
        </p>

        <div className="mt-8 flex flex-col gap-5">
          <div>
            <p className={`mb-2 ${OG_LABEL}`}>Install</p>
            <div className={OG_CODE_BLOCK}>
              npx skills add https://github.com/rejot-dev/fragno --skill fragno
            </div>
          </div>

          <div>
            <p className={`mb-2 ${OG_LABEL}`}>Then ask</p>
            <div className="rounded-xl border border-blue-300/70 bg-blue-100/70 px-5 py-4 text-xl font-medium text-blue-900 dark:border-blue-400/40 dark:bg-blue-500/20 dark:text-blue-100">
              "Use the fragno skill to integrate the Stripe fragment into my app."
            </div>
          </div>
        </div>
      </div>
    </OgSlideFrame>
  );
}
