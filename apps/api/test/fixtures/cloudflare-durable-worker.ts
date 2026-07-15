export {
  TokenMonsterRateLimitDurableObject,
  TokenMonsterSuppressionLedgerDurableObject
} from "@tokenmonster/api/cloudflare-durable-objects";

export default Object.freeze({
  fetch(): Response {
    return new Response("durable object bundle verification", { status: 200 });
  }
});
