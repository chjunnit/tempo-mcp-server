/**
 * Get Tempo worklog summary aggregated by week/epic/issue/author
 */
export class GetWorklogSummaryService {
    constructor(jiraApi, tempoApi) {
        this.jiraApi = jiraApi;
        this.tempoApi = tempoApi;
    }
    async execute(args) {
        const { jql, from, to, group_by = ['week', 'epic'] } = args;
        console.error('=== Get Worklog Summary ===');
        console.error(`  JQL: ${jql}`);
        console.error(`  Period: ${from} to ${to}`);
        console.error(`  Group by: ${group_by.join(', ')}`);
        // 1. Resolve issues and map to epics
        console.error('  Resolving issues and epics...');
        const issues = await this.jiraApi.searchIssues(jql, ['id', 'key', 'parent']);
        const issueIds = [];
        const issueIdToKey = new Map();
        const issueToEpic = new Map();
        for (const issue of issues) {
            const issueId = parseInt(issue.id, 10);
            issueIds.push(issueId);
            issueIdToKey.set(issueId, issue.key);
            // Get epic key from parent (or self if no parent)
            const epicKey = issue.fields.parent?.key || issue.key;
            issueToEpic.set(issueId, epicKey);
        }
        console.error(`    Found ${issueIds.length} issues`);
        if (issueIds.length === 0) {
            return {
                summary: [],
                controlSum: { totalHours: 0, totalCount: 0 },
                metadata: { from, to, issueCount: 0, worklogCount: 0, groupBy: group_by },
            };
        }
        // 2. Fetch worklogs
        console.error('  Fetching worklogs from Tempo...');
        const worklogs = await this.tempoApi.searchWorklogs(issueIds, from, to);
        console.error(`    Found ${worklogs.length} worklogs`);
        // 3. Group worklogs
        console.error('  Grouping worklogs...');
        const grouped = new Map();
        for (const worklog of worklogs) {
            const worklogDate = new Date(worklog.startDate);
            const issueId = parseInt(worklog.issue.id.toString(), 10);
            // Calculate ISO week
            const { isoYear, isoWeek, weekStart } = this.getISOWeek(worklogDate);
            // Build group key
            const keyParts = [];
            const entry = {
                hours: 0,
                worklogCount: 0,
            };
            for (const dim of group_by) {
                switch (dim) {
                    case 'week':
                        keyParts.push(`${isoYear}-W${String(isoWeek).padStart(2, '0')}`);
                        entry.isoYear = isoYear;
                        entry.isoWeek = isoWeek;
                        entry.weekStart = weekStart;
                        break;
                    case 'epic':
                        keyParts.push(issueToEpic.get(issueId) || '');
                        entry.epicKey = issueToEpic.get(issueId);
                        break;
                    case 'issue':
                        keyParts.push(issueIdToKey.get(issueId) || '');
                        entry.issueKey = issueIdToKey.get(issueId);
                        break;
                    case 'author':
                        keyParts.push(worklog.author.accountId);
                        entry.author = worklog.author.accountId;
                        break;
                }
            }
            const groupKey = keyParts.join('|');
            if (!grouped.has(groupKey)) {
                grouped.set(groupKey, entry);
            }
            const group = grouped.get(groupKey);
            group.hours += Math.round((worklog.timeSpentSeconds / 3600) * 100) / 100;
            group.worklogCount += 1;
        }
        // 4. Sort and format summary
        const summary = Array.from(grouped.values()).sort((a, b) => {
            // Sort by year, week, epic
            if (a.isoYear !== b.isoYear)
                return (a.isoYear || 0) - (b.isoYear || 0);
            if (a.isoWeek !== b.isoWeek)
                return (a.isoWeek || 0) - (b.isoWeek || 0);
            if (a.epicKey !== b.epicKey)
                return (a.epicKey || '').localeCompare(b.epicKey || '');
            return 0;
        });
        // 5. Calculate control sum
        const totalHours = summary.reduce((sum, entry) => sum + entry.hours, 0);
        const totalCount = summary.reduce((sum, entry) => sum + entry.worklogCount, 0);
        return {
            summary,
            controlSum: {
                totalHours: Math.round(totalHours * 100) / 100,
                totalCount,
            },
            metadata: {
                from,
                to,
                issueCount: issueIds.length,
                worklogCount: worklogs.length,
                groupBy: group_by,
            },
        };
    }
    /**
     * Calculate ISO week number (ISO 8601)
     * Week starts on Monday, first week has at least 4 days in January
     */
    getISOWeek(date) {
        const target = new Date(date.valueOf());
        const dayNr = (date.getDay() + 6) % 7; // Monday = 0, Sunday = 6
        target.setDate(target.getDate() - dayNr + 3); // Thursday of current week
        const jan4 = new Date(target.getFullYear(), 0, 4);
        const dayDiff = (target.valueOf() - jan4.valueOf()) / 86400000;
        const weekNo = 1 + Math.ceil(dayDiff / 7);
        // Get Monday of the week
        const monday = new Date(date.valueOf());
        monday.setDate(monday.getDate() - dayNr);
        const weekStart = monday.toISOString().substring(0, 10);
        return {
            isoYear: target.getFullYear(),
            isoWeek: weekNo,
            weekStart,
        };
    }
}
//# sourceMappingURL=get-worklog-summary.js.map