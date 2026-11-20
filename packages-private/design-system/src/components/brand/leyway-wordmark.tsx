/**
 * The Leyway wordmark: "leyway" set in Outfit Medium, outlined and kerned as Outfit sets it. It
 * takes the surrounding text color; `className` sets its height. Its box reaches down to the
 * descenders of the "y"s (200 units below the baseline), so it is drawn lower by the share of its
 * height that centers the "l" (720 of 920 units, from the top) where the box's center is: centered
 * in a row, the letters sit centered, and the descenders hang below.
 * Decorative: the links around it carry the name.
 */
export function LeywayWordmark({ className }: { className: string }) {
  return (
    <svg
      viewBox="61 -720 3027 920"
      aria-hidden="true"
      className={`block shrink-0 translate-y-[10.9%] ${className}`}
    >
      <g transform="scale(1,-1)" fill="currentColor">
        <path d="M61 0V720H171V0Z" />
        <path d="M516 -10Q444 -10 386.5 22.5Q329 55 295.5 112Q262 169 262 240Q262 311 295 367.5Q328 424 384.5 457Q441 490 510 490Q577 490 628.5 459Q680 428 709.5 374Q739 320 739 251Q739 239 737.5 226.5Q736 214 733 199H339V289H676L635 253Q633 297 618 327Q603 357 575.5 373Q548 389 508 389Q466 389 435 371Q404 353 387 320.5Q370 288 370 243Q370 198 388 164Q406 130 439 111.5Q472 93 515 93Q552 93 583.5 106Q615 119 637 144L707 73Q672 32 622 11Q572 -10 516 -10Z" />
        <path d="M974 -5 769 480H890L1030 124H995L1143 480H1265L1042 -5ZM831 -200 980 107 1042 -5 953 -200Z" />
        <path d="M1449 0 1256 480H1370L1500 131L1466 130L1593 480H1657L1784 130L1750 131L1880 480H1994L1801 0H1737L1607 332H1643L1513 0Z" />
        <path d="M2252 -10Q2187 -10 2134.5 23Q2082 56 2051.5 112.5Q2021 169 2021 239Q2021 310 2051.5 366.5Q2082 423 2134.5 456.5Q2187 490 2252 490Q2307 490 2349.5 466.5Q2392 443 2417 402Q2442 361 2442 309V171Q2442 119 2417.5 78Q2393 37 2350 13.5Q2307 -10 2252 -10ZM2270 94Q2331 94 2368.5 135Q2406 176 2406 240Q2406 283 2389 316Q2372 349 2341.5 367.5Q2311 386 2270 386Q2230 386 2199.5 367.5Q2169 349 2151.5 316Q2134 283 2134 240Q2134 197 2151.5 164Q2169 131 2199.5 112.5Q2230 94 2270 94ZM2399 0V129L2418 246L2399 362V480H2509V0Z" />
        <path d="M2786 -5 2581 480H2702L2842 124H2807L2955 480H3077L2854 -5ZM2643 -200 2792 107 2854 -5 2765 -200Z" />
      </g>
    </svg>
  );
}
