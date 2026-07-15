# @tokenmonster/byok-openai

Local-only OpenAI Responses adapter for TokenMonster's Electron main process.
It sends a user-initiated prompt directly to OpenAI with the user's local API
key. TokenMonster cloud is never part of this request path.

## Fixed request policy

- The only endpoint is `https://api.openai.com/v1/responses`.
- Fetch redirects are rejected so prompts cannot be forwarded to another
  origin.
- The only model is `gpt-5.6-luna`.
- Requests contain only `model`, `instructions`, text `input`,
  `max_output_tokens`, explicit `background: false`, and `store: false`.
- Provider keys and prompt text are never logged or copied into errors.
- Response time, bytes, and stream chunks are bounded with a monotonic deadline,
  and callers may cancel locally. Allowlisted reasoning items are ignored and
  only completed assistant `output_text` message items are returned; tool,
  refusal, incomplete, oversized, and malformed output fails closed. Rejected
  response bodies are canceled without being parsed or logged.

The package has no runtime dependencies. Tests inject a fake fetch function and
never use a real credential or network connection.

## Verification

From the repository root:

    npm run test --workspace @tokenmonster/byok-openai
    npm run typecheck --workspace @tokenmonster/byok-openai
    npm run build --workspace @tokenmonster/byok-openai
