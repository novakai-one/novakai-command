import type { ProjectionRebuildResult } from '../../contract/records/projections.js';

interface PersistedProjectionRebuild {
  readonly sequence: number;
  readonly result: ProjectionRebuildResult;
}

/** Latest replace-all projection snapshot; authoritative records live elsewhere. */
export class ProjectionState {
  private result: ProjectionRebuildResult = { usageRollups: [], toolCalls: [] };

  restore(items: readonly PersistedProjectionRebuild[]): void {
    const latest = [...items].sort((a, b) => a.sequence - b.sequence).at(-1);
    if (latest !== undefined) this.result = latest.result;
  }

  async replace(
    result: ProjectionRebuildResult,
    persist: (value: ProjectionRebuildResult) => Promise<void>,
  ): Promise<ProjectionRebuildResult> {
    await persist(result);
    this.result = result;
    return result;
  }

  read(): ProjectionRebuildResult {
    return this.result;
  }
}

export type { PersistedProjectionRebuild };
