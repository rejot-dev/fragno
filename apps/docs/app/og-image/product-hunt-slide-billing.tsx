import {
  OG_CARD,
  OG_CODE_BLOCK,
  OG_LABEL,
  OG_LAYOUT,
  OG_LIST,
  OG_TITLE,
  OgSlideFrame,
} from "./slide-frame";

export function ProductHuntSlideBilling() {
  return (
    <OgSlideFrame>
      <div className={OG_LAYOUT}>
        <h1 className={OG_TITLE}>
          Stripe{" "}
          <span className="bg-linear-to-r from-violet-600 to-violet-500 bg-clip-text text-transparent dark:from-violet-300 dark:to-violet-500">
            Billing
          </span>{" "}
          Fragment
        </h1>

        <div className="mt-8 grid grid-cols-2 gap-5">
          <div className={OG_CARD}>
            <p className={OG_LABEL}>Includes</p>
            <ul className={OG_LIST}>
              <li>Checkout + billing portal flows</li>
              <li>Webhook synchronization</li>
              <li>Subscription state in your database</li>
            </ul>
          </div>

          <div className={OG_CARD}>
            <p className={OG_LABEL}>Server Setup</p>
            <ul className={OG_LIST}>
              <li>Stripe secret key + webhook secret</li>
              <li>Customer reference mapping</li>
              <li>Mount route handlers in your adapter</li>
            </ul>
          </div>
        </div>

        <div className={`mt-5 ${OG_CODE_BLOCK}`}>npm install @fragno-dev/stripe @fragno-dev/db</div>
      </div>
    </OgSlideFrame>
  );
}
