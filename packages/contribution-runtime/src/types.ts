import type { SupportedIngestSnapshot } from "@tokenmonster/contracts";

export type ContributionState =
  | "off"
  | "active"
  | "stopped"
  | "deletion-pending"
  | "deletion-complete"
  | "deletion-failed"
  | "unavailable";

export interface ContributionRuntimeStatus {
  readonly configured: boolean;
  readonly secureStorage: "os-backed" | "unavailable";
  readonly state: ContributionState;
  readonly enabled: boolean;
  readonly canEnable: boolean;
  readonly canDelete: boolean;
  /** True only when recover() has a durable authority it can retry. */
  readonly canRecover: boolean;
  readonly outboxPending: number;
  readonly consentDocumentRevision: string | null;
  readonly deletion: Readonly<{
    jobId: string;
    status: "queued" | "running" | "complete" | "failed";
    requestedAt: string;
    finishedAt: string | null;
    anonymousHistoricalTotalsRetained: true;
  }> | null;
}

export interface ContributionPreview {
  readonly previewId: string;
  readonly expiresAt: string;
  readonly document: Readonly<{
    revision: string;
    title: string;
    summary: string;
    retentionDisclosure: string;
  }>;
  readonly fieldAllowlist: readonly string[];
  readonly forbidden: readonly string[];
  readonly payload: SupportedIngestSnapshot | null;
  readonly eligibleBucketCount: number;
  readonly remainingEligibleBucketCount: number;
}

export type ContributionActionCode =
  | "enabled"
  | "resumed"
  | "stopped"
  | "pause-pending"
  | "deletion-requested"
  | "deletion-status-updated"
  | "uploaded"
  | "nothing-due"
  | "api-not-configured"
  | "secure-storage-unavailable"
  | "secure-storage-failed"
  | "contract-mismatch"
  | "network-error"
  | "timeout"
  | "rate-limited"
  | "server-unavailable"
  | "request-rejected"
  | "local-data-too-large"
  | "authority-conflict"
  | "local-service-error"
  | "preview-expired"
  | "state-conflict"
  | "not-enabled"
  | "consent-stale"
  | "deletion-credential-unavailable"
  | "deletion-status-unavailable"
  | "busy";

export interface ContributionActionResult {
  readonly ok: boolean;
  readonly code: ContributionActionCode;
  readonly status: ContributionRuntimeStatus;
}

export interface ContributionSyncResult extends ContributionActionResult {
  readonly uploadedBatches: number;
}

export interface ContributionDeletionResult extends ContributionActionResult {}
