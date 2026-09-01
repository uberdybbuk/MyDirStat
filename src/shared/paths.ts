/**
 * Path encoding shared by the server and the browser. One definition, so the
 * URL the CLI prints and the URL the page rewrites can never disagree.
 */

/**
 * Percent-encode a path for a query string, leaving the characters that make it
 * readable alone.
 *
 * RFC 3986 defines `query = *( pchar / "/" / "?" )` and `pchar` includes ":",
 * so both the separator and a Windows drive colon are legal literals. Escaping
 * them is what turns `C:/Users/me` into the unreadable `C%3A%2FUsers%2Fme`.
 * Everything else stays encoded — "&", "=", "#" and "?" would otherwise break
 * out of the parameter.
 */
export function encodePathParam(path: string): string {
    return encodeURIComponent(path).replace(/%2F/g, '/').replace(/%3A/g, ':');
}
