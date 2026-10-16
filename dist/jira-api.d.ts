/**
 * Jira REST API client for changelog and issue data
 */
export interface JiraConfig {
    email: string;
    apiToken: string;
    baseUrl?: string;
}
export interface JiraIssue {
    id: string;
    key: string;
    fields: {
        issuetype?: {
            name: string;
        };
        status?: {
            name: string;
            statusCategory?: {
                name: string;
            };
        };
        resolution?: {
            name: string;
        } | null;
        resolutiondate?: string | null;
        created?: string;
        customfield_10008?: number | null;
        fixVersions?: Array<{
            name: string;
        }>;
        parent?: {
            key: string;
        };
        [key: string]: any;
    };
}
export interface JiraChange {
    issueKey: string;
    changedAt: string;
    field: string;
    fieldId?: string;
    from: string;
    to: string;
    author?: string;
}
export interface ChangelogResult {
    changes: JiraChange[];
    currentValues?: JiraIssue[];
}
export declare class JiraApiError extends Error {
    status?: number | undefined;
    response?: unknown | undefined;
    constructor(message: string, status?: number | undefined, response?: unknown | undefined);
}
export declare class JiraApi {
    private baseUrl;
    private headers;
    private fieldMapping;
    constructor(config: JiraConfig);
    private request;
    /**
     * Search issues by JQL using the new /search/jql endpoint
     */
    searchIssues(jql: string, fields?: string[]): Promise<JiraIssue[]>;
    /**
     * Fetch changelogs using bulk changelog endpoint
     */
    getChangelogs(issueKeysOrIds: string[], fields: string[], since?: string): Promise<JiraChange[]>;
    /**
     * Get current field values for issues
     */
    getCurrentValues(issueKeysOrIds: string[]): Promise<JiraIssue[]>;
}
//# sourceMappingURL=jira-api.d.ts.map