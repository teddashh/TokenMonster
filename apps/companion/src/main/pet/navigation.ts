export type NavigationGuard = (
  event: { preventDefault(): void },
  targetUrl: string
) => void;

export function petViewUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("view", "pet");
  return parsed.toString();
}

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
