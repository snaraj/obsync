/**
 * One browser HTTP surface on every platform. Redirect refusal is selected
 * before any send; there is no requestUrl fallback. Cross-origin servers and
 * authenticating edges must support credential-free CORS preflight.
 *
 * Fetch reports redirect/CORS/TLS/network failure alike. Leave that failure
 * to Transport's bounded retries and one-shot lost-response accounting.
 */
import type { HttpRequest, HttpResponse } from "./transport";

export async function fetchHttp(request: HttpRequest): Promise<HttpResponse> {
  // Old stored addresses may bypass current settings normalization. Refuse
  // before fetch can echo URL credentials in its construction error.
  try {
    const url = new URL(request.url);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") throw new Error();
  } catch {
    throw new TypeError("obsync refused the server URL; use HTTP(S) without URL credentials.");
  }
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    redirect: "error",
    credentials: "omit",
    mode: "cors",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  // Buffer exactly once: both views describe the same response bytes. The
  // transport retains its existing post-buffer response ceilings/cancellation.
  const arrayBuffer = await response.arrayBuffer();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => { headers[name] = value; });
  return { status: response.status, headers, arrayBuffer, text: new TextDecoder().decode(arrayBuffer) };
}
