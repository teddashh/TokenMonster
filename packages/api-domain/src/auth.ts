import { ApiDomainError } from "./errors.js";
import type {
  CredentialCandidate,
  CredentialLookupPort,
  CredentialScope,
  CredentialService
} from "./types.js";
import {
  assertBearerToken,
  assertStoredCredential
} from "./validation.js";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export async function authenticateCredential(
  bearerInput: unknown,
  scope: CredentialScope,
  credentials: CredentialService,
  lookup: CredentialLookupPort
): Promise<Readonly<{ bearerToken: string; candidate: CredentialCandidate }>> {
  const bearerToken = assertBearerToken(bearerInput);
  const presented = await credentials.inspect(bearerToken);
  if (
    presented === null ||
    !OPAQUE_ID_PATTERN.test(presented.publicTokenId)
  ) {
    throw new ApiDomainError("TOKEN_INVALID");
  }
  const candidate = await lookup.findCredentialCandidate(
    scope,
    presented.publicTokenId
  );
  await assertCandidateValid(
    bearerToken,
    scope,
    presented.publicTokenId,
    candidate,
    credentials
  );
  return Object.freeze({ bearerToken, candidate: candidate as CredentialCandidate });
}

export async function assertCandidateValid(
  bearerToken: string,
  scope: CredentialScope,
  publicTokenId: string,
  candidate: CredentialCandidate | null,
  credentials: CredentialService
): Promise<void> {
  if (
    candidate === null ||
    !OPAQUE_ID_PATTERN.test(candidate.installationId) ||
    candidate.credential.publicTokenId !== publicTokenId
  ) {
    throw new ApiDomainError("TOKEN_INVALID");
  }
  const stored = assertStoredCredential(candidate.credential, scope);
  if (!(await credentials.verify(bearerToken, stored))) {
    throw new ApiDomainError("TOKEN_INVALID");
  }
}
