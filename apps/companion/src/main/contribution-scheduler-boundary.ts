import type {
  ContributionActionResult,
  ContributionDeletionResult
} from "@tokenmonster/contribution-runtime"

interface ContributionStopPort {
  stop(): Promise<ContributionActionResult>
}

interface ContributionDeletionPort {
  requestDeletion(): Promise<ContributionDeletionResult>
}

interface ContributionSchedulerPausePort {
  pause(): void
}

/**
 * A user Stop request is a process-local scheduling boundary even when remote
 * or secure-storage cleanup cannot complete. Only a later explicit action may
 * resume background contribution work.
 */
export async function stopContributionWithSchedulerPaused(
  contribution: ContributionStopPort,
  scheduler: ContributionSchedulerPausePort
): Promise<ContributionActionResult> {
  scheduler.pause()
  return await contribution.stop()
}

/**
 * Deletion establishes the same hard scheduling boundary before any mutation
 * starts. A failed deletion must stay paused for an explicit user recovery.
 */
export async function deleteContributionWithSchedulerPaused(
  contribution: ContributionDeletionPort,
  scheduler: ContributionSchedulerPausePort
): Promise<ContributionDeletionResult> {
  scheduler.pause()
  return await contribution.requestDeletion()
}
