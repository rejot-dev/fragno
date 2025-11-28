"use client";

import { User } from "lucide-react";
import { Stripe } from "./logos/stripe";

export function StripeDataFlow({
  mode = "with-fragment",
}: {
  mode?: "with-fragment" | "without-fragment";
} = {}) {
  return (
    <div className="not-prose mx-auto my-8 w-full max-w-4xl">
      <svg
        viewBox="0 0 177.84321 70.451725"
        className="h-auto w-full"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <marker
            style={{ overflow: "visible" }}
            id="marker17"
            refX="0"
            refY="0"
            orient="auto-start-reverse"
            markerWidth="1"
            markerHeight="1"
            viewBox="0 0 1 1"
            preserveAspectRatio="xMidYMid"
          >
            <path
              className="fill-none stroke-gray-500"
              strokeWidth="1"
              strokeLinecap="butt"
              d="M 3,-3 0,0 3,3"
              transform="rotate(180,0.125,0)"
            />
          </marker>
          <marker
            style={{ overflow: "visible" }}
            id="ArrowWide"
            refX="0"
            refY="0"
            orient="auto-start-reverse"
            markerWidth="1"
            markerHeight="1"
            viewBox="0 0 1 1"
            preserveAspectRatio="xMidYMid"
          >
            <path
              className="fill-none stroke-gray-500"
              strokeWidth="1"
              strokeLinecap="butt"
              d="M 3,-3 0,0 3,3"
              transform="rotate(180,0.125,0)"
            />
          </marker>
          <marker
            style={{ overflow: "visible" }}
            id="marker17-8"
            refX="0"
            refY="0"
            orient="auto-start-reverse"
            markerWidth="1"
            markerHeight="1"
            viewBox="0 0 1 1"
            preserveAspectRatio="xMidYMid"
          >
            <path
              className="fill-none stroke-gray-500"
              strokeWidth="1"
              strokeLinecap="butt"
              d="M 3,-3 0,0 3,3"
              transform="rotate(180,0.125,0)"
            />
          </marker>
          <marker
            style={{ overflow: "visible" }}
            id="ArrowWide-3"
            refX="0"
            refY="0"
            orient="auto-start-reverse"
            markerWidth="1"
            markerHeight="1"
            viewBox="0 0 1 1"
            preserveAspectRatio="xMidYMid"
          >
            <path
              className="fill-none stroke-gray-500"
              strokeWidth="1"
              strokeLinecap="butt"
              d="M 3,-3 0,0 3,3"
              transform="rotate(180,0.125,0)"
            />
          </marker>
          <marker
            style={{ overflow: "visible" }}
            id="marker17-89"
            refX="0"
            refY="0"
            orient="auto-start-reverse"
            markerWidth="1"
            markerHeight="1"
            viewBox="0 0 1 1"
            preserveAspectRatio="xMidYMid"
          >
            <path
              className="fill-none stroke-gray-500"
              strokeWidth="1"
              strokeLinecap="butt"
              d="M 3,-3 0,0 3,3"
              transform="rotate(180,0.125,0)"
            />
          </marker>
          <marker
            style={{ overflow: "visible" }}
            id="ArrowWide-6"
            refX="0"
            refY="0"
            orient="auto-start-reverse"
            markerWidth="1"
            markerHeight="1"
            viewBox="0 0 1 1"
            preserveAspectRatio="xMidYMid"
          >
            <path
              className="fill-none stroke-gray-500"
              strokeWidth="1"
              strokeLinecap="butt"
              d="M 3,-3 0,0 3,3"
              transform="rotate(180,0.125,0)"
            />
          </marker>
          <marker
            style={{ overflow: "visible" }}
            id="ArrowWide-7"
            refX="0"
            refY="0"
            orient="auto-start-reverse"
            markerWidth="1"
            markerHeight="1"
            viewBox="0 0 1 1"
            preserveAspectRatio="xMidYMid"
          >
            <path
              className="fill-none stroke-gray-500"
              strokeWidth="1"
              strokeLinecap="butt"
              d="M 3,-3 0,0 3,3"
              transform="rotate(180,0.125,0)"
            />
          </marker>
        </defs>

        <g transform="translate(-6.9222773,-32.304599)">
          {/* Backend section */}
          <g transform="translate(-19.550766,16.370258)">
            <rect
              className="fill-emerald-300 stroke-emerald-500 dark:fill-emerald-900/30"
              strokeWidth="0.5"
              strokeLinejoin="round"
              width="37.337727"
              height="24.292088"
              x="114.23689"
              y="24.611847"
              rx="0.99999994"
              ry="0.99999994"
            />
            <text
              xmlSpace="preserve"
              className="fill-fd-foreground"
              style={{ fontSize: "3.5px" }}
              textAnchor="middle"
              x="132.427"
              y="29.5"
            >
              Backend
            </text>
            {mode === "with-fragment" && (
              <>
                <rect
                  className="fill-blue-200 stroke-blue-400 dark:fill-blue-900/30"
                  strokeWidth="0.5"
                  strokeLinejoin="round"
                  width="37.337723"
                  height="16.236961"
                  x="114.23689"
                  y="32.666973"
                  rx="0.99999994"
                  ry="0.99999994"
                />
                <text
                  xmlSpace="preserve"
                  className="fill-fd-foreground dark:fill-blue-300"
                  style={{ fontSize: "2.82223px" }}
                  textAnchor="middle"
                  x="132.51332"
                  y="37.060215"
                >
                  Stripe Fragment Server
                </text>
                <text
                  xmlSpace="preserve"
                  className="fill-fd-foreground font-mono dark:fill-blue-300"
                  style={{ fontSize: "2.82223px" }}
                  textAnchor="middle"
                  x="132.83841"
                  y="42.156647"
                >
                  <tspan x="132.83841" y="42.156647">
                    /api/stripe/upgrade
                  </tspan>
                  <tspan x="132.83841" y="45.684433">
                    /api/stripe/webhook
                  </tspan>
                </text>
              </>
            )}
          </g>

          {/* User icon */}
          <g transform="matrix(2.0999434,0,0,2.0999434,-151.42658,-107.98133)">
            <foreignObject x="75.40625" y="72.265117" width="4.7625" height="5.291667">
              <div className="flex h-full w-full items-center justify-center">
                <User className="text-fd-foreground h-full w-full" />
              </div>
            </foreignObject>
          </g>

          {/* Frontend section */}
          <g transform="translate(-80.261039,16.089625)">
            <rect
              className="fill-emerald-300 stroke-emerald-500 dark:fill-emerald-900/30"
              strokeWidth="0.5"
              strokeLinejoin="round"
              width="37.337727"
              height="24.292088"
              x="114.23689"
              y="24.611847"
              rx="0.99999994"
              ry="0.99999994"
            />
            <text
              xmlSpace="preserve"
              className="fill-fd-foreground"
              style={{ fontSize: "3.5px" }}
              textAnchor="middle"
              x="132.427"
              y="29.5"
            >
              Frontend
            </text>
            {mode === "with-fragment" && (
              <>
                <rect
                  className="fill-blue-200 stroke-blue-400 dark:fill-blue-900/30"
                  strokeWidth="0.5"
                  strokeLinejoin="round"
                  width="37.337723"
                  height="16.236961"
                  x="114.23689"
                  y="32.666973"
                  rx="0.99999994"
                  ry="0.99999994"
                />
                <text
                  xmlSpace="preserve"
                  className="fill-fd-foreground dark:fill-blue-300"
                  style={{ fontSize: "2.82223px" }}
                  textAnchor="middle"
                  x="132.51332"
                  y="37.060215"
                >
                  Stripe Fragment Client
                </text>
                <text
                  xmlSpace="preserve"
                  className="fill-fd-foreground font-mono dark:fill-blue-300"
                  style={{ fontSize: "2.82223px" }}
                  textAnchor="middle"
                  x="132.83841"
                  y="42.156647"
                >
                  <tspan x="132.83841" y="42.156647">
                    upgradeSubscription()
                  </tspan>
                  <tspan x="132.83841" y="45.684433">
                    cancelSubscription()
                  </tspan>
                </text>
              </>
            )}
          </g>

          {/* Stripe API section */}
          <g transform="translate(-40.852669,62.90349)">
            <rect
              className="fill-purple-200 stroke-purple-400 dark:fill-purple-900/30"
              strokeWidth="0.5"
              strokeLinejoin="round"
              width="37.337723"
              height="16.236961"
              x="135.47145"
              y="23.218994"
              rx="0.99999994"
              ry="0.99999994"
            />
            <foreignObject x="141" y="27.5" width="6" height="6">
              <div className="flex h-full w-full items-center justify-center">
                <Stripe className="h-full w-full" />
              </div>
            </foreignObject>
            <text
              xmlSpace="preserve"
              className="fill-fd-foreground"
              style={{ fontSize: "2.82223px" }}
              textAnchor="middle"
              x="158.5"
              y="31.447556"
            >
              Stripe API
            </text>
          </g>

          {/* Database */}
          <g transform="matrix(0.78462349,0,0,0.78462349,32.48633,20.827496)">
            <path
              className={
                mode === "with-fragment"
                  ? "fill-blue-200 stroke-blue-400 dark:fill-blue-900/30"
                  : "fill-emerald-300 stroke-emerald-500 dark:fill-emerald-900/30"
              }
              strokeWidth="0.6"
              d="m 162.5245,34.962788 v 18.057371 a 15.522482,3.869437 0 0 0 31.04495,0 V 34.962788"
            />
            <text
              xmlSpace="preserve"
              className={
                mode === "with-fragment"
                  ? "fill-fd-foreground font-mono dark:fill-blue-300"
                  : "fill-fd-foreground font-mono"
              }
              style={{ fontSize: "3px" }}
              textAnchor="middle"
              x="178.29018"
              y="52.833584"
            >
              subscriptions
            </text>
            <path
              className="fill-emerald-300 stroke-emerald-500 dark:fill-emerald-900/30"
              strokeWidth="0.6"
              d="m 162.5245,25.934103 v 18.057371 a 15.522482,3.869437 0 0 0 31.04495,0 V 25.934103"
            />
            <path
              className="fill-none stroke-emerald-500"
              strokeWidth="0.6"
              d="m 162.5245,34.962791 a 15.522482,3.869437 0 0 0 31.04495,0"
            />
            <ellipse
              className="fill-emerald-300 stroke-emerald-500 dark:fill-emerald-900/30"
              strokeWidth="0.6"
              cx="178.047"
              cy="25.934101"
              rx="15.522478"
              ry="3.8694367"
            />
            <text
              xmlSpace="preserve"
              className="fill-fd-foreground"
              style={{ fontSize: "3.59692px" }}
              textAnchor="middle"
              x="178.03738"
              y="27.153463"
            >
              DB
            </text>
          </g>

          {/* Arrows */}
          <g>
            <path
              className="fill-none stroke-gray-500"
              strokeWidth="0.6"
              strokeLinejoin="round"
              markerStart="url(#marker17)"
              markerEnd="url(#ArrowWide)"
              d="m 74.469892,49.110775 h 17.3057"
            />
            <path
              className="fill-none stroke-gray-500"
              strokeWidth="0.6"
              strokeLinejoin="round"
              markerEnd="url(#ArrowWide-7)"
              d="m 19.811818,49.037231 h 11.69304"
            />
            <path
              className="fill-none stroke-gray-500"
              strokeWidth="0.6"
              strokeLinejoin="round"
              markerStart="url(#marker17-89)"
              markerEnd="url(#ArrowWide-6)"
              d="m 137.23814,49.110775 h 17.3057"
            />
            <path
              className="fill-none stroke-gray-500"
              strokeWidth="0.6"
              strokeLinejoin="round"
              markerStart="url(#marker17-8)"
              d="M 107.60189,82.223648 V 68.659719"
            />
            <path
              className="fill-none stroke-gray-500"
              strokeWidth="0.6"
              strokeLinejoin="round"
              markerEnd="url(#ArrowWide-3)"
              d="M 119.48203,82.504281 V 68.940352"
            />
            <text
              xmlSpace="preserve"
              className="fill-fd-foreground"
              style={{ fontSize: "2.82223px" }}
              textAnchor="middle"
              x="126.32645"
              y="75.5"
            >
              <tspan x="128.32645" y="75.5">
                Webhook
              </tspan>
              <tspan x="128.32645" y="78.5">
                Events
              </tspan>
            </text>
            <text
              xmlSpace="preserve"
              className="fill-fd-foreground"
              style={{ fontSize: "2.82223px" }}
              textAnchor="middle"
              x="102.82191"
              y="75.84964"
            >
              API
            </text>
          </g>

          {/* Legend */}
          <g transform="translate(27,80)">
            {/* Green - Developer */}
            <rect
              className="fill-emerald-300 stroke-emerald-500 dark:fill-emerald-900/30"
              strokeWidth="0.5"
              width="4"
              height="3"
              x="0"
              y="0"
              rx="0.5"
              ry="0.5"
            />
            <text
              xmlSpace="preserve"
              className="fill-fd-foreground"
              style={{ fontSize: "2.5px" }}
              x="5"
              y="2.2"
            >
              Developer
            </text>

            {/* Blue - Stripe Fragment */}
            {mode === "with-fragment" && (
              <>
                <rect
                  className="fill-blue-200 stroke-blue-400 dark:fill-blue-900/30"
                  strokeWidth="0.5"
                  width="4"
                  height="3"
                  x="0"
                  y="4"
                  rx="0.5"
                  ry="0.5"
                />
                <text
                  xmlSpace="preserve"
                  className="fill-fd-foreground"
                  style={{ fontSize: "2.5px" }}
                  x="5"
                  y="6.2"
                >
                  Stripe Fragment
                </text>
              </>
            )}

            {/* Purple - Stripe */}
            <rect
              className="fill-purple-200 stroke-purple-400 dark:fill-purple-900/30"
              strokeWidth="0.5"
              width="4"
              height="3"
              x="0"
              y="8"
              rx="0.5"
              ry="0.5"
            />
            <text
              xmlSpace="preserve"
              className="fill-fd-foreground"
              style={{ fontSize: "2.5px" }}
              x="5"
              y="10.2"
            >
              Stripe
            </text>
          </g>
        </g>
      </svg>
    </div>
  );
}
