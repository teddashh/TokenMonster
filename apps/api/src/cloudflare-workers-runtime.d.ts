/**
 * Minimal runtime module surface used by the deploy-only Durable Object entry.
 * Wrangler supplies this virtual module; keeping the declaration structural
 * avoids merging Cloudflare's Worker globals into this package's DOM build.
 */
declare module "cloudflare:workers" {
  export abstract class DurableObject<Environment = unknown> {
    constructor(context: unknown, environment: Environment);
  }
}
