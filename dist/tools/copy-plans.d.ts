/**
 * Copy Tempo Planner allocations from one person to others
 */
import { TempoApi } from '../tempo-api.js';
export interface CopyPlansArgs {
    source_account_id: string;
    target_team_id?: string;
    target_account_ids?: string[];
    from: string;
    to: string;
    project_ids?: number[];
    conflict_mode?: 'Add' | 'Keep' | 'Replace';
    skip_holidays?: boolean;
    max_weekly_hours?: number;
    dry_run?: boolean;
}
export interface PlanEntry {
    date: string;
    projectId: number;
    projectName: string;
    hours: number;
    action: 'add' | 'replace' | 'skip';
    existingHours: number;
    newTotalHours: number;
    plannedSeconds: number;
}
export interface TargetResult {
    accountId: string;
    entries: PlanEntry[];
    totalHours: number;
    skippedHolidays: number;
    conflicts: number;
    warnings: string[];
}
export interface CopyPlansResult {
    action: 'Preview' | 'Write';
    source: {
        accountId: string;
        from: string;
        to: string;
        planCount: number;
        dateCount: number;
    };
    targets: TargetResult[];
    totalHoursCopied: number;
    totalEntries: number;
    totalConflicts: number;
    totalSkippedHolidays: number;
    warnings: string[];
    conflictMode: string;
    writtenCount?: number;
}
export declare class CopyPlansService {
    private tempoApi;
    constructor(tempoApi: TempoApi);
    execute(args: CopyPlansArgs): Promise<CopyPlansResult>;
    private resolveTargets;
    private groupPlansByDate;
    private processTarget;
    private calculateWeeklyTotals;
    private writePlans;
}
//# sourceMappingURL=copy-plans.d.ts.map