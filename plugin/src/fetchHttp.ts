/**
 * One browser HTTP surface on every platform. Redirect refusal is selected
 * before any send; there is no requestUrl fallback. Cross-origin servers and
 * authenticating edges must support credential-free CORS preflight.
 *
 * Fetch reports redirect/CORS/TLS/network failure alike. Leave that failure
 * to Transport's bounded retries and one-shot lost-response accounting.
 */
import { addressRefusal, type HttpRequest, type HttpResponse } from "./transport";

/**
 * THE LAST HOP JUDGES THE URL IT IS HANDED, by the one address rule
 * (`addressRefusal`), whoever built it: a caller that does not come through
 * `Transport.destination` still cannot send plain HTTP off this computer, or
 * send to what does not parse. `isMobile` is required, so no caller can leave
 * the platform out. Refused before fetch can echo URL credentials in its
 * construction error.
 */
export async function fetchHttp(request: HttpRequest, isMobile: boolean): Promise<HttpResponse> {
  if (addressRefusal(request.url, isMobile) !== null) {
    throw new TypeError("obsync refused the server URL; use HTTPS, or plain HTTP only to this computer, without URL credentials.");
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
