import "./app.css";

import { brandFontLatinUrl } from "@fragno-private/design-system/brand-font";
import { ButtonLink } from "@fragno-private/design-system/button";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
} from "react-router";

import type { Route } from "./+types/root";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link
          rel="preload"
          href={brandFontLatinUrl}
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <Meta />
        <Links />
      </head>
      <body data-backoffice-root>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function Root() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return (
    <main className="mx-auto max-w-2xl space-y-5 px-6 py-20">
      <h1 className="text-3xl font-semibold">
        {isRouteErrorResponse(error) && error.status === 404
          ? "Page not found"
          : "Something went wrong"}
      </h1>
      <p>Try again, or return to the homepage.</p>
      <ButtonLink variant="solid" to="/">
        Go home
      </ButtonLink>
    </main>
  );
}
