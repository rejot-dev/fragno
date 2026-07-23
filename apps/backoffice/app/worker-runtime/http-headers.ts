export const getSetCookieHeaders = (headers: Headers): string[] =>
  (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
  (headers.get("Set-Cookie") ? [headers.get("Set-Cookie")!] : []);
