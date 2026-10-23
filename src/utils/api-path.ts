/**
 * Safe construction of API URL paths from caller-supplied identifiers.
 */

/**
 * Tagged template that percent-encodes every interpolated value as a single
 * path segment, so IDs containing `/`, `?`, `#` or `%` cannot change which
 * endpoint is called or what query string is sent.
 *
 * `encodeURIComponent` leaves `.` untouched and URL parsers collapse `.` and
 * `..` segments (encoded or not), so empty and dot-only values are rejected.
 *
 * @example apiPath`/usage/sessions/${sessionId}`
 * @throws Error if an interpolated value is empty, `.` or `..`
 */
export function apiPath(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  let result = strings[0];
  values.forEach((value, i) => {
    const segment = String(value ?? "");
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`Invalid path segment '${segment}' in ${strings.join("{}")}`);
    }
    result += encodeURIComponent(segment) + strings[i + 1];
  });
  return result;
}
