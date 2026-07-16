export type NavigationGuard = (
  event: { preventDefault(): void },
  targetUrl: string
) => void;

/** Fail-closed: anything unparseable or off-origin is prevented. */
export function originNavigationGuard(origin: string): NavigationGuard {
  return (event, targetUrl) => {
    let allowed = false;
    try {
      allowed = new URL(targetUrl).origin === origin;
    } catch {
      allowed = false;
    }
    if (!allowed) event.preventDefault();
  };
}
