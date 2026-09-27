/**
 * Whether the developer context inspector is laid over the screen at this URL.
 *
 * The inspector is a fixed, bottom-left overlay, and that is the right shape for a screen you are *working*
 * in: it answers "what did the agent actually know?" about the step on screen, next to the step. On a
 * screen you are *reading* it is in the way — on the dashboard it sat across the "today" card and the
 * totals it was standing over, which is what it was reported as. Nothing about the panel needs a report
 * page: the context it shows is rebuilt per request from the current session.
 *
 * Developer builds only, either way: the panel itself checks `simulatorEnabled`.
 */

const DASHBOARD_ROUTE = '/dashboard';

/**
 * Whether this URL is the dashboard route.
 *
 * Segments rather than a bare prefix: `/dashboard-roundup` is a different screen, and hiding the inspector
 * there because the first ten characters match would be a bug nobody would find by looking.
 */
function isDashboardRoute(url: string): boolean {
  if (url === DASHBOARD_ROUTE) return true;
  return ['/', '?', '#'].some((separator) => url.startsWith(DASHBOARD_ROUTE + separator));
}

export function contextInspectorVisibleOn(url: string): boolean {
  return !isDashboardRoute(url);
}
