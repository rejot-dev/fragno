"use client";

import { Mail, User } from "lucide-react";

export function ResendDataFlow({
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
            {mode === "without-fragment" ? (
              <rect
                className="fill-[color-mix(in_srgb,var(--editorial-primary)_18%,transparent)] stroke-[color-mix(in_srgb,var(--editorial-primary)_60%,transparent)] dark:fill-[color-mix(in_srgb,var(--editorial-primary)_14%,transparent)]"
                strokeWidth="0.5"
                strokeLinejoin="round"
                width="37.337727"
                height="24.292088"
                x="114.23689"
                y="24.611847"
                rx="1"
                ry="1"
              />
            ) : (
              <>
                <path
                  className="fill-[color-mix(in_srgb,var(--editorial-primary)_18%,transparent)] stroke-[color-mix(in_srgb,var(--editorial-primary)_60%,transparent)] dark:fill-[color-mix(in_srgb,var(--editorial-primary)_14%,transparent)]"
                  strokeWidth="0.5"
                  strokeLinejoin="round"
                  d="M 114.23689 32.666973 v -7.055126 a 1 1 0 0 1 1 -1 h 35.337727 a 1 1 0 0 1 1 1 v 7.055126 z"
                />
                <path
                  className="fill-[color-mix(in_srgb,var(--editorial-secondary)_18%,transparent)] stroke-[color-mix(in_srgb,var(--editorial-secondary)_60%,transparent)] dark:fill-[color-mix(in_srgb,var(--editorial-secondary)_14%,transparent)]"
                  strokeWidth="0.5"
                  strokeLinejoin="round"
                  d="M 114.23689 32.666973 h 37.337727 v 15.236961 a 1 1 0 0 1 -1 1 h -35.337727 a 1 1 0 0 1 -1 -1 z"
                />
              </>
            )}
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
                <text
                  xmlSpace="preserve"
                  className="fill-fd-foreground"
                  style={{ fontSize: "2.82223px" }}
                  textAnchor="middle"
                  x="132.51332"
                  y="37.060215"
                >
                  Resend Routes
                </text>
                <text
                  xmlSpace="preserve"
                  className="fill-fd-foreground font-mono"
                  style={{ fontSize: "2.5px" }}
                  textAnchor="middle"
                  x="132.83841"
                  y="42.156647"
                >
                  <tspan x="132.83841" y="42.156647">
                    /resend/webhook
                  </tspan>
                  <tspan x="132.83841" y="45.684433">
                    /email/received
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
            {mode === "without-fragment" ? (
              <rect
                className="fill-[color-mix(in_srgb,var(--editorial-primary)_18%,transparent)] stroke-[color-mix(in_srgb,var(--editorial-primary)_60%,transparent)] dark:fill-[color-mix(in_srgb,var(--editorial-primary)_14%,transparent)]"
                strokeWidth="0.5"
                strokeLinejoin="round"
                width="37.337727"
                height="24.292088"
                x="114.23689"
                y="24.611847"
                rx="1"
                ry="1"
              />
            ) : (
              <>
                <path
                  className="fill-[color-mix(in_srgb,var(--editorial-primary)_18%,transparent)] stroke-[color-mix(in_srgb,var(--editorial-primary)_60%,transparent)] dark:fill-[color-mix(in_srgb,var(--editorial-primary)_14%,transparent)]"
                  strokeWidth="0.5"
                  strokeLinejoin="round"
                  d="M 114.23689 32.666973 v -7.055126 a 1 1 0 0 1 1 -1 h 35.337727 a 1 1 0 0 1 1 1 v 7.055126 z"
                />
                <path
                  className="fill-[color-mix(in_srgb,var(--editorial-secondary)_18%,transparent)] stroke-[color-mix(in_srgb,var(--editorial-secondary)_60%,transparent)] dark:fill-[color-mix(in_srgb,var(--editorial-secondary)_14%,transparent)]"
                  strokeWidth="0.5"
                  strokeLinejoin="round"
                  d="M 114.23689 32.666973 h 37.337727 v 15.236961 a 1 1 0 0 1 -1 1 h -35.337727 a 1 1 0 0 1 -1 -1 z"
                />
              </>
            )}
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
                <text
                  xmlSpace="preserve"
                  className="fill-fd-foreground"
                  style={{ fontSize: "2.82223px" }}
                  textAnchor="middle"
                  x="132.51332"
                  y="37.060215"
                >
                  Client-side hooks
                </text>
                <text
                  xmlSpace="preserve"
                  className="fill-fd-foreground font-mono"
                  style={{ fontSize: "2.5px" }}
                  textAnchor="middle"
                  x="132.83841"
                  y="42.156647"
                >
                  <tspan x="132.83841" y="42.156647">
                    useReceivedEmails()
                  </tspan>
                </text>
              </>
            )}
          </g>

          {/* Resend API section */}
          <g transform="translate(-40.852669,62.90349)">
            <rect
              className="fill-[color-mix(in_srgb,var(--editorial-tertiary)_18%,transparent)] stroke-[color-mix(in_srgb,var(--editorial-tertiary)_60%,transparent)] dark:fill-[color-mix(in_srgb,var(--editorial-tertiary)_14%,transparent)]"
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
                <Mail className="text-fd-foreground h-full w-full" />
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
              Resend API
            </text>
          </g>

          {/* Database */}
          <g transform="matrix(0.78462349,0,0,0.78462349,32.48633,20.827496)">
            {mode === "with-fragment" && (
              <path
                className="fill-[color-mix(in_srgb,var(--editorial-secondary)_18%,transparent)] stroke-[color-mix(in_srgb,var(--editorial-secondary)_60%,transparent)] dark:fill-[color-mix(in_srgb,var(--editorial-secondary)_14%,transparent)]"
                strokeWidth="0.6"
                d="M 162.5245 34.962791 V 53.020162 A 15.522478 3.8694367 0 0 0 178.047 56.8895987 A 15.522478 3.8694367 0 0 0 193.56945 53.020162 V 34.962791 A 15.522478 3.8694367 0 0 1 178.047 38.8322277 A 15.522478 3.8694367 0 0 1 162.5245 34.962791 Z"
              />
            )}
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
              y="48.3"
            >
              webhookEvents
            </text>
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
              y="52.3"
            >
              emailMessage
            </text>
            <path
              className="fill-[color-mix(in_srgb,var(--editorial-primary)_18%,transparent)] stroke-[color-mix(in_srgb,var(--editorial-primary)_60%,transparent)] dark:fill-[color-mix(in_srgb,var(--editorial-primary)_14%,transparent)]"
              strokeWidth="0.6"
              d={
                mode === "with-fragment"
                  ? "M 162.5245 25.934103 V 34.962791 A 15.522478 3.8694367 0 0 0 178.047 38.8322277 A 15.522478 3.8694367 0 0 0 193.56945 34.962791 V 25.934103 A 15.522478 3.8694367 0 0 1 178.047 29.8035397 A 15.522478 3.8694367 0 0 1 162.5245 25.934103 Z"
                  : "M 162.5245 25.934103 V 53.020162 A 15.522478 3.8694367 0 0 0 178.047 56.8895987 A 15.522478 3.8694367 0 0 0 193.56945 53.020162 V 25.934103 A 15.522478 3.8694367 0 0 1 178.047 29.8035397 A 15.522478 3.8694367 0 0 1 162.5245 25.934103 Z"
              }
            />
            <ellipse
              className="fill-[color-mix(in_srgb,var(--editorial-primary)_18%,transparent)] stroke-[color-mix(in_srgb,var(--editorial-primary)_60%,transparent)] dark:fill-[color-mix(in_srgb,var(--editorial-primary)_14%,transparent)]"
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
            {/* Primary - App */}
            <rect
              className="fill-[color-mix(in_srgb,var(--editorial-primary)_18%,transparent)] stroke-[color-mix(in_srgb,var(--editorial-primary)_60%,transparent)] dark:fill-[color-mix(in_srgb,var(--editorial-primary)_14%,transparent)]"
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
              Layer
            </text>

            {/* Secondary - Resend fragment */}
            {mode === "with-fragment" && (
              <>
                <rect
                  className="fill-[color-mix(in_srgb,var(--editorial-secondary)_18%,transparent)] stroke-[color-mix(in_srgb,var(--editorial-secondary)_60%,transparent)] dark:fill-[color-mix(in_srgb,var(--editorial-secondary)_14%,transparent)]"
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
                  Resend integration
                </text>
              </>
            )}

            {/* Tertiary - Resend */}
            <rect
              className="fill-[color-mix(in_srgb,var(--editorial-tertiary)_18%,transparent)] stroke-[color-mix(in_srgb,var(--editorial-tertiary)_60%,transparent)] dark:fill-[color-mix(in_srgb,var(--editorial-tertiary)_14%,transparent)]"
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
              Resend
            </text>
          </g>
        </g>
      </svg>
    </div>
  );
}
