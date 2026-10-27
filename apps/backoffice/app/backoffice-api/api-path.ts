/** Whether a request is for the versioned Backoffice API, which the API router serves. */
export function isBackofficeApiPath(pathname: string): boolean {
  return /^\/api\/v\d+(?:\/|$)/u.test(pathname);
}
