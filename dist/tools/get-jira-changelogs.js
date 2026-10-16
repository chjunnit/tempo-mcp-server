/**
 * Get Jira changelog history for burn-up tracking
 */
export class GetJiraChangelogsService {
    constructor(jiraApi) {
        this.jiraApi = jiraApi;
        // Default fields to track
        this.defaultFields = [
            'customfield_10008', // Story Points
            'status',
            'resolution',
            'fixVersions',
            'parent',
        ];
    }
    async execute(args) {
        const { jql, issue_keys = [], fields = this.defaultFields, since, include_current = true, } = args;
        console.error('=== Get Jira Changelogs ===');
        // 1. Resolve issue keys
        let issueKeys;
        if (jql) {
            console.error(`  Searching issues with JQL: ${jql}`);
            const issues = await this.jiraApi.searchIssues(jql, ['key']);
            issueKeys = issues.map(i => i.key);
            console.error(`    Found ${issueKeys.length} issues`);
        }
        else if (issue_keys.length > 0) {
            issueKeys = issue_keys;
            console.error(`  Using ${issueKeys.length} provided issue keys`);
        }
        else {
            throw new Error('Either jql or issue_keys must be provided');
        }
        if (issueKeys.length === 0) {
            throw new Error('No issues found');
        }
        // 2. Fetch changelogs
        console.error(`  Fetching changelogs for ${issueKeys.length} issues...`);
        console.error(`    Fields: ${fields.join(', ')}`);
        if (since) {
            console.error(`    Since: ${since}`);
        }
        const changes = await this.jiraApi.getChangelogs(issueKeys, fields, since);
        console.error(`    Found ${changes.length} changes`);
        // 3. Fetch current values if requested
        let enrichedCurrentValues;
        if (include_current) {
            console.error(`  Fetching current values...`);
            const currentValues = await this.jiraApi.getCurrentValues(issueKeys);
            enrichedCurrentValues = currentValues.map(issue => this.enrichIssue(issue));
            console.error(`    Found ${enrichedCurrentValues.length} issues`);
        }
        return {
            changes,
            currentValues: enrichedCurrentValues,
            metadata: {
                issueCount: issueKeys.length,
                changeCount: changes.length,
                fields,
                since,
            },
        };
    }
    /**
     * Enrich issue with computed fields for easier consumption
     */
    enrichIssue(issue) {
        return {
            ...issue,
            storyPoints: issue.fields.customfield_10008 || null,
            statusName: issue.fields.status?.name,
            resolutionName: issue.fields.resolution?.name || null,
            fixVersionNames: issue.fields.fixVersions?.map(v => v.name) || [],
            parentKey: issue.fields.parent?.key || null,
        };
    }
}
//# sourceMappingURL=get-jira-changelogs.js.map