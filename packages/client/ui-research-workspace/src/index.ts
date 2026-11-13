/**
 * Research workspace Web surface, Host half. Pure UI plugin: the empty apply
 * exists so the package appears in the Host loader; the browser half ships via
 * `exports["./client"]`.
 */

/** Host plugin body — no Host-side behavior for this surface plugin. */
export function apply(): void {}
