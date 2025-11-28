import { cn } from "@/lib/cn";

interface VueProps {
  className?: string;
}

export function Vue({ className }: VueProps) {
  return (
    <svg
      width="20.074516mm"
      height="17.337072mm"
      viewBox="0 0 20.074516 17.337072"
      version="1.1"
      id="svg1"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("", className)}
    >
      <defs id="defs1" />
      <g id="layer1" transform="translate(-127.16647,-139.83146)">
        <g
          style={{ fill: "currentColor" }}
          id="g8"
          transform="matrix(0.91247693,0,0,0.91247693,126.25311,137.09404)"
        >
          <path
            d="M 3.31677,3 12.001,18 20.6852,3 h 2.3158 l -11,19 L 1.00098,3 Z M 7.65887,3 12.001,10.5 16.3431,3 h 2.3158 L 12.001,14.5 5.34308,3 Z"
            id="path1-02"
          />
        </g>
      </g>
    </svg>
  );
}
