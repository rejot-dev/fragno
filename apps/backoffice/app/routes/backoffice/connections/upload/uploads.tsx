import { redirect, type LoaderFunctionArgs } from "react-router";

export async function loader({ params }: LoaderFunctionArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  return redirect(`/backoffice/connections/upload/${params.orgId}/files`);
}

export default function BackofficeOrganisationUploadUploadsRedirect() {
  return null;
}
