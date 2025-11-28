import { cn } from "@/lib/cn";

interface KyselyProps {
  className?: string;
}

export function Kysely({ className }: KyselyProps) {
  return (
    <svg
      stroke="currentColor"
      fill="none"
      strokeWidth={"0"}
      role="img"
      viewBox="0 0 132 132"
      height="200px"
      width="200px"
      className={cn("", className)}
      xmlns="http://www.w3.org/2000/svg"
    >
      <g clipPath="url(#clip0_8_3)">
        <rect x="2" y="2" width="128" height="128" rx="16" fill="white" />
        <path
          d="M41.2983 109V23.9091H46.4918V73.31H47.0735L91.9457 23.9091H98.8427L61.9062 64.1694L98.5103 109H92.0288L58.5824 67.9087L46.4918 81.2873V109H41.2983Z"
          fill="black"
        />
      </g>
      <rect x="2" y="2" width="128" height="128" rx="16" stroke="#121212" strokeWidth="4" />
      <defs>
        <clipPath id="clip0_8_3">
          <rect x="2" y="2" width="128" height="128" rx="16" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
}
