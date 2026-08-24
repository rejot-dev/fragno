import { redirect, type LoaderFunctionArgs } from "react-router";

export async function loader({ params }: LoaderFunctionArgs) {
  if (!params.orgSlug) {
    throw new Response("Not Found", { status: 404 });
  }

  return redirect(`/backoffice/connections/upload/${encodeURIComponent(params.orgSlug)}/files`);
}

export default function BackofficeOrganizationUploadUploadsRedirect() {
  return null;
}
