import "./app.css";

import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&display=optional",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const baseUrl =
    import.meta.env.MODE === "development" ? "http://localhost:3000" : "https://fragno.dev";
  const description = "Fragno backoffice administration app";

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="description" content={description} />
        <meta property="og:title" content="Fragno Backoffice" />
        <meta property="og:description" content={description} />
        <meta property="og:url" content={baseUrl} />
        <meta property="og:type" content="website" />
        <Meta />
        <Links />
      </head>
      <body className="flex min-h-screen flex-col">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Unexpected error";
  let details = "An unexpected error occurred while loading this page.";

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "Not Found" : "Request failed";
    details = error.statusText || details;
  } else if (error instanceof Error) {
    details = error.message;
  }

  return (
    <div className="bg-background min-h-screen p-10 text-sm">
      <h1 className="text-2xl font-semibold">{message}</h1>
      <p className="mt-2 text-zinc-600">{details}</p>
    </div>
  );
}
