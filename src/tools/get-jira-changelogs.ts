/**
 * Get Jira changelog history for burn-up tracking
 */

import { JiraApi, JiraChange, JiraIssue } from '../jira-api.js';

export interface GetJiraChangelogsArgs {
  jql?: string;
  issue_keys?: string[];
  fields?: string[];
  since?: string; // yyyy-MM-dd
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
  // Add computed fields for easier consumption
  storyPoints?: number | null;
  statusName?: string;
  resolutionName?: string | null;
  fixVersionNames?: string[];
  parentKey?: string | null;
}

export class GetJiraChangelogsService {
  // Default fields to track
  private defaultFields = [
    'customfield_10008', // Story Points
    'status',
    'resolution',
    'fixVersions',
    'parent',
  ];

  constructor(private jiraApi: JiraApi) {}

  async execute(args: GetJiraChangelogsArgs): Promise<ChangelogsResult> {
    const {
      jql,
      issue_keys = [],
      fields = this.defaultFields,
      since,
      include_current = true,
    } = args;

    console.error('=== Get Jira Changelogs ===');

    // 1. Resolve issue keys
    let issueKeys: string[];

    if (jql) {
      console.error(`  Searching issues with JQL: ${jql}`);
      const issues = await this.jiraApi.searchIssues(jql, ['key']);
      issueKeys = issues.map(i => i.key);
      console.error(`    Found ${issueKeys.length} issues`);
    } else if (issue_keys.length > 0) {
      issueKeys = issue_keys;
      console.error(`  Using ${issueKeys.length} provided issue keys`);
    } else {
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
    let enrichedCurrentValues: EnrichedIssue[] | undefined;

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
  private enrichIssue(issue: JiraIssue): EnrichedIssue {
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
