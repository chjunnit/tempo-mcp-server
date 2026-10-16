/**
 * Get Jira changelog history for burn-up tracking
 */
import { JiraApi, JiraChange, JiraIssue } from '../jira-api.js';
export interface GetJiraChangelogsArgs {
    jql?: string;
    issue_keys?: string[];
    fields?: string[];
    since?: string;
    include_current?: boolean;
}
export interface ChangelogsResult {
    changes: JiraChange[];
    currentValues?: EnrichedIssue[];
    metadata: {
        issueCount: number;
        changeCount: number;
        fields: string[];
        since?: string;
    };
}
export interface EnrichedIssue extends JiraIssue {
    storyPoints?: number | null;
    statusName?: string;
    resolutionName?: string | null;
    fixVersionNames?: string[];
    parentKey?: string | null;
}
export declare class GetJiraChangelogsService {
    private jiraApi;
    private defaultFields;
    constructor(jiraApi: JiraApi);
    execute(args: GetJiraChangelogsArgs): Promise<ChangelogsResult>;
    /**
     * Enrich issue with computed fields for easier consumption
     */
    private enrichIssue;
}
//# sourceMappingURL=get-jira-changelogs.d.ts.map