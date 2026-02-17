import {
  OG_CARD,
  OG_CODE_BLOCK,
  OG_LABEL,
  OG_LAYOUT,
  OG_LIST,
  OG_TITLE,
  OgSlideFrame,
} from "./slide-frame";

export function ProductHuntSlideAuth() {
  return (
    <OgSlideFrame>
      <div className={OG_LAYOUT}>
        <h1 className={OG_TITLE}>
          <span className="bg-linear-to-r from-emerald-600 to-emerald-500 bg-clip-text text-transparent dark:from-emerald-300 dark:to-emerald-500">
            Auth
          </span>{" "}
          Fragment
        </h1>

        <div className="mt-8 grid grid-cols-2 gap-5">
          <div className={OG_CARD}>
            <p className={OG_LABEL}>Includes</p>
            <ul className={OG_LIST}>
              <li>Users and sessions</li>
              <li>Organizations, members, and roles</li>
              <li>Invitation flows</li>
            </ul>
          </div>

          <div className={OG_CARD}>
            <p className={OG_LABEL}>Route Surface</p>
            <ul className="mt-3 space-y-2 font-mono text-lg text-slate-700 dark:text-slate-200">
              <li>GET /me</li>
              <li>POST /sign-up, /sign-in, /sign-out</li>
              <li>Organization + invitation endpoints</li>
            </ul>
          </div>
        </div>

        <div className={`mt-5 ${OG_CODE_BLOCK}`}>npm install @fragno-dev/auth @fragno-dev/db</div>
      </div>
    </OgSlideFrame>
  );
}
