/**
 * Jira REST API client for changelog and issue data
 */
export class JiraApiError extends Error {
    constructor(message, status, response) {
        super(message);
        this.status = status;
        this.response = response;
        this.name = 'JiraApiError';
    }
}
export class JiraApi {
    constructor(config) {
        // Field mapping: Jira field ID → changelog field name
        this.fieldMapping = {
            'customfield_10008': 'Story Points',
            'status': 'status',
            'resolution': 'resolution',
            'fixVersions': 'Fix Version',
            'parent': 'IssueParentAssociation',
        };
        this.baseUrl = config.baseUrl || 'https://starwiki.atlassian.net';
        const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
        this.headers = {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        };
    }
    async request(method, path, body) {
        const url = `${this.baseUrl}${path}`;
        try {
            const response = await fetch(url, {
                method,
                headers: this.headers,
                body: body ? JSON.stringify(body) : undefined,
            });
            // Rate limiting delay
            await new Promise(resolve => setTimeout(resolve, 200));
            if (!response.ok) {
                let errorMessage = `HTTP ${response.status}`;
                try {
                    const errorBody = await response.json();
                    if (errorBody.errorMessages && errorBody.errorMessages.length > 0) {
                        errorMessage += `: ${errorBody.errorMessages.join(', ')}`;
                    }
                    else if (errorBody.errors) {
                        errorMessage += `: ${JSON.stringify(errorBody.errors)}`;
                    }
                }
                catch {
                    errorMessage += `: ${response.statusText}`;
                }
                throw new JiraApiError(errorMessage, response.status);
            }
            return await response.json();
        }
        catch (error) {
            if (error instanceof JiraApiError) {
                throw error;
            }
            throw new JiraApiError(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Search issues by JQL using the new /search/jql endpoint
     */
    async searchIssues(jql, fields = ['key']) {
        const allIssues = [];
        let nextPageToken = undefined;
        const maxResults = 1000;
        do {
            const body = {
                jql,
                fields,
                maxResults,
            };
            if (nextPageToken) {
                body.nextPageToken = nextPageToken;
            }
            const result = await this.request('POST', '/rest/api/3/search/jql', body);
            allIssues.push(...result.issues);
            nextPageToken = result.nextPageToken;
        } while (nextPageToken);
        return allIssues;
    }
    /**
     * Fetch changelogs using bulk changelog endpoint
     */
    async getChangelogs(issueKeysOrIds, fields, since) {
        const allChanges = [];
        // Build field list: include both field IDs and mapped names
        const changelogFields = new Set();
        for (const field of fields) {
            changelogFields.add(field);
            if (this.fieldMapping[field]) {
                changelogFields.add(this.fieldMapping[field]);
            }
        }
        // Build issue ID → key mapping
        const issueIdToKey = new Map();
        if (issueKeysOrIds.length > 0) {
            const jql = `key in (${issueKeysOrIds.join(',')})`;
            const issues = await this.searchIssues(jql, ['key']);
            for (const issue of issues) {
                issueIdToKey.set(issue.id, issue.key);
            }
        }
        // Fetch changelogs in batches (max 1000 per call)
        const batchSize = 1000;
        for (let i = 0; i < issueKeysOrIds.length; i += batchSize) {
            const batch = issueKeysOrIds.slice(i, i + batchSize);
            const result = await this.request('POST', '/rest/api/3/changelog/bulkfetch', {
                issueIdsOrKeys: batch,
            });
            // Parse changelogs
            for (const issueLog of result.issueChangeLogs) {
                const issueKey = issueIdToKey.get(issueLog.issueId) || issueLog.issueId;
                for (const history of issueLog.changeHistories) {
                    for (const change of history.items) {
                        // Filter by field
                        if (changelogFields.has(change.field) || (change.fieldId && changelogFields.has(change.fieldId))) {
                            const changedAt = new Date(history.created).toISOString();
                            // Filter by since date
                            if (since && changedAt < since) {
                                continue;
                            }
                            allChanges.push({
                                issueKey,
                                changedAt,
                                field: change.field,
                                fieldId: change.fieldId,
                                from: change.fromString || '',
                                to: change.toString || '',
                                author: history.author?.displayName,
                            });
                        }
                    }
                }
            }
        }
        return allChanges;
    }
    /**
     * Get current field values for issues
     */
    async getCurrentValues(issueKeysOrIds) {
        if (issueKeysOrIds.length === 0) {
            return [];
        }
        const jql = `key in (${issueKeysOrIds.join(',')})`;
        const fields = [
            'key',
            'issuetype',
            'status',
            'resolution',
            'resolutiondate',
            'created',
            'customfield_10008', // Story Points
            'fixVersions',
            'parent',
        ];
        return await this.searchIssues(jql, fields);
    }
}
//# sourceMappingURL=jira-api.js.map