/**
 * Copy Tempo Planner allocations from one person to others
 * Copies plans as PERIODS (not individual days), preserving includesNonWorkingDays
 */
import { TempoApi } from '../tempo-api.js';
export interface CopyPlansArgs {
    source_account_id: string;
    target_team_id?: string;
    target_account_ids?: string[];
    from: string;
    to: string;
    project_ids?: number[];
    project_mapping?: Record<number, number>;
    conflict_mode?: 'Add' | 'Keep' | 'Replace';
    skip_holidays?: boolean;
    max_weekly_hours?: number;
    dry_run?: boolean;
}
export interface PlanEntry {
    startDate: string;
    endDate: string;
    projectId: number;
    projectName: string;
    projectType: 'PROJECT' | 'ISSUE';
    hours: number;
    secondsPerDay: number;
    includesNonWorkingDays: boolean;
    action: 'add' | 'replace' | 'skip';
    conflictInfo?: string;
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
    };
    targets: TargetResult[];
    totalHoursCopied: number;
    totalEntries: number;
    totalConflicts: number;
    totalSkippedHolidays: number;
    warnings: string[];
    conflictMode: string;
    writtenCount?: number;
    debug?: {
        sourcePlansRaw: any[];
        clippingLog: string[];
        clippedPlansCount: number;
    };
}
export declare class CopyPlansService {
    private tempoApi;
    constructor(tempoApi: TempoApi);
    execute(args: CopyPlansArgs): Promise<CopyPlansResult>;
    private resolveTargets;
    /**
     * Clip plans to the window [from, to] and calculate seconds for the clipped period
     * Preserves includesNonWorkingDays flag from source
     * Applies project mapping if specified
     */
    private clipPlansToWindow;
    private countDays;
    private processTarget;
    private countWeeks;
    private writePlans;
}
//# sourceMappingURL=copy-plans.d.ts.map