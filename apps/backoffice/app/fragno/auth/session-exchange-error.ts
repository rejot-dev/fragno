export async function readBackofficeSessionExchangeErrorMessage(
  response: Response,
): Promise<string> {
  const responseText = (await response.text()).trim();
  if (!responseText) {
    return "Unable to prepare the Backoffice session.";
  }
  try {
    const payload = JSON.parse(responseText) as { message?: unknown };
    return typeof payload.message === "string" ? payload.message : responseText;
  } catch {
    return responseText;
  }
}
