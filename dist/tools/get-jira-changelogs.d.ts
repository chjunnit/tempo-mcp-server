/**
 * Get Jira changelog history for burn-up tracking
 */
import { JiraApi, JiraChange } from '../jira-api.js';
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
export interface EnrichedIssue {
    key: string;
    issueType?: string;
    created?: string;
    statusName?: string;
    statusCategory?: string;
    resolutionName?: string | null;
    resolutionDate?: string | null;
    storyPoints?: number | null;
    fixVersionNames?: string[];
    parentKey?: string | null;
}
export declare class GetJiraChangelogsService {
    private jiraApi;
    private defaultFields;
    constructor(jiraApi: JiraApi);
    execute(args: GetJiraChangelogsArgs): Promise<ChangelogsResult>;
    /**
     * Enrich issue with flat fields only (no nested objects)
     */
    private enrichIssue;
}
//# sourceMappingURL=get-jira-changelogs.d.ts.map