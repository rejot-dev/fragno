import type { SVGProps } from "react";

export function Stripe(props: SVGProps<SVGSVGElement>): React.ReactElement {
  return (
    <svg
      width="512"
      height="512"
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g clipPath="url(#clip0_159_20)">
        <rect width="512" height="512" fill="#533AFD" />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M120 392L392 334.317V120L120 178.357V392Z"
          fill="white"
        />
      </g>
      <defs>
        <clipPath id="clip0_159_20">
          <rect width="512" height="512" rx="64" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
}
