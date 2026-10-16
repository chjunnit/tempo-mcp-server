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
    issuetype?: { name: string };
    status?: { name: string };
    resolution?: { name: string } | null;
    resolutiondate?: string | null;
    created?: string;
    customfield_10008?: number | null; // Story Points
    fixVersions?: Array<{ name: string }>;
    parent?: { key: string };
    [key: string]: any;
  };
}

export interface JiraChange {
  issueKey: string;
  changedAt: string; // ISO timestamp
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

export class JiraApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public response?: unknown
  ) {
    super(message);
    this.name = 'JiraApiError';
  }
}

export class JiraApi {
  private baseUrl: string;
  private headers: Record<string, string>;

  // Field mapping: Jira field ID → changelog field name
  private fieldMapping: Record<string, string> = {
    'customfield_10008': 'Story Points',
    'status': 'status',
    'resolution': 'resolution',
    'fixVersions': 'Fix Version',
    'parent': 'IssueParentAssociation',
  };

  constructor(config: JiraConfig) {
    this.baseUrl = config.baseUrl || 'https://starwiki.atlassian.net';
    const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
    this.headers = {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
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
          const errorBody = await response.json() as { errorMessages?: string[]; errors?: Record<string, string> };
          if (errorBody.errorMessages && errorBody.errorMessages.length > 0) {
            errorMessage += `: ${errorBody.errorMessages.join(', ')}`;
          } else if (errorBody.errors) {
            errorMessage += `: ${JSON.stringify(errorBody.errors)}`;
          }
        } catch {
          errorMessage += `: ${response.statusText}`;
        }
        throw new JiraApiError(errorMessage, response.status);
      }

      return await response.json() as T;
    } catch (error) {
      if (error instanceof JiraApiError) {
        throw error;
      }
      throw new JiraApiError(
        `Request failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Search issues by JQL using the new /search/jql endpoint
   */
  async searchIssues(jql: string, fields: string[] = ['key']): Promise<JiraIssue[]> {
    const allIssues: JiraIssue[] = [];
    let nextPageToken: string | undefined = undefined;
    const maxResults = 1000;

    do {
      const body: Record<string, unknown> = {
        jql,
        fields,
        maxResults,
      };

      if (nextPageToken) {
        body.nextPageToken = nextPageToken;
      }

      const result = await this.request<{
        issues: JiraIssue[];
        nextPageToken?: string;
      }>('POST', '/rest/api/3/search/jql', body);

      allIssues.push(...result.issues);
      nextPageToken = result.nextPageToken;
    } while (nextPageToken);

    return allIssues;
  }

  /**
   * Fetch changelogs using bulk changelog endpoint
   */
  async getChangelogs(
    issueKeysOrIds: string[],
    fields: string[],
    since?: string
  ): Promise<JiraChange[]> {
    const allChanges: JiraChange[] = [];

    // Build field list: include both field IDs and mapped names
    const changelogFields = new Set<string>();
    for (const field of fields) {
      changelogFields.add(field);
      if (this.fieldMapping[field]) {
        changelogFields.add(this.fieldMapping[field]);
      }
    }

    // Build issue ID → key mapping
    const issueIdToKey = new Map<string, string>();
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

      const result = await this.request<{
        issueChangeLogs: Array<{
          issueId: string;
          changeHistories: Array<{
            created: number; // Unix timestamp in milliseconds
            author?: { displayName?: string };
            items: Array<{
              field: string;
              fieldId?: string;
              fromString?: string;
              toString?: string;
            }>;
          }>;
        }>;
      }>('POST', '/rest/api/3/changelog/bulkfetch', {
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
  async getCurrentValues(issueKeysOrIds: string[]): Promise<JiraIssue[]> {
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
