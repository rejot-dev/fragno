import { cn } from "@/lib/cn";

interface NextjsProps {
  className?: string;
}

export function Nextjs({ className }: NextjsProps) {
  return (
    <svg
      width="21.707113mm"
      height="21.707106mm"
      viewBox="0 0 21.707113 21.707106"
      version="1.1"
      id="svg1"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("", className)}
    >
      <defs id="defs1" />
      <g id="layer1" transform="translate(-38.548207,-137.64645)">
        <g
          style={{ fill: "currentColor" }}
          id="g3"
          transform="matrix(1.0853556,0,0,1.0853556,36.377499,135.47573)"
        >
          <path
            d="M 17.6644,17.6493 10.2602,8 H 8 v 8 h 2 v -5.0538 l 6.0869,7.9326 C 14.8907,19.5909 13.4931,20 12,20 7.58172,20 4,16.4183 4,12 4,7.58172 7.58172,4 12,4 c 4.4183,0 8,3.58172 8,8 0,2.2053 -0.8923,4.2022 -2.3356,5.6493 z M 12,22 C 17.5228,22 22,17.5228 22,12 22,6.47715 17.5228,2 12,2 6.47715,2 2,6.47715 2,12 2,17.5228 6.47715,22 12,22 Z M 14,12 V 8 h 2 v 4 z"
            id="path1-2"
            style={{ fill: "currentColor" }}
          />
        </g>
      </g>
    </svg>
  );
}
