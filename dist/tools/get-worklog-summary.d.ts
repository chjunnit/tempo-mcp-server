/**
 * Get Tempo worklog summary aggregated by week/epic/issue/author
 */
import { JiraApi } from '../jira-api.js';
import { TempoApi } from '../tempo-api.js';
export interface GetWorklogSummaryArgs {
    jql: string;
    from: string;
    to: string;
    group_by?: string[];
}
export interface WorklogSummaryEntry {
    isoYear?: number;
    isoWeek?: number;
    weekStart?: string;
    epicKey?: string;
    issueKey?: string;
    author?: string;
    hours: number;
    worklogCount: number;
}
export interface WorklogSummaryResult {
    summary: WorklogSummaryEntry[];
    controlSum: {
        totalHours: number;
        totalCount: number;
    };
    metadata: {
        from: string;
        to: string;
        issueCount: number;
        worklogCount: number;
        groupBy: string[];
    };
}
export declare class GetWorklogSummaryService {
    private jiraApi;
    private tempoApi;
    constructor(jiraApi: JiraApi, tempoApi: TempoApi);
    execute(args: GetWorklogSummaryArgs): Promise<WorklogSummaryResult>;
    /**
     * Calculate ISO week number (ISO 8601)
     * Week starts on Monday, first week has at least 4 days in January
     */
    private getISOWeek;
}
//# sourceMappingURL=get-worklog-summary.d.ts.map