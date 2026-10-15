/**
 * Get Tempo plans and/or worklogs for teams and individuals
 */
export class GetTempoDataService {
    constructor(tempoApi) {
        this.tempoApi = tempoApi;
    }
    async execute(args) {
        const { from, to, team_ids = [], account_ids = [], data_type = 'Both', } = args;
        console.error(`=== Get Tempo Data: ${from} to ${to} ===`);
        // 1. Resolve accounts from teams and direct IDs
        const accounts = await this.resolveAccounts(team_ids, account_ids, from, to);
        if (accounts.size === 0) {
            throw new Error('No accounts found. Specify team_ids or account_ids.');
        }
        console.error(`  Found ${accounts.size} accounts`);
        const accountList = Array.from(accounts.keys());
        // 2. Fetch data based on type
        let plans;
        let worklogs;
        if (data_type === 'Plans' || data_type === 'Both') {
            plans = await this.fetchPlans(accountList, from, to, accounts);
        }
        if (data_type === 'Worklogs' || data_type === 'Both') {
            worklogs = await this.fetchWorklogs(accountList, from, to, accounts);
        }
        return {
            from,
            to,
            accounts: accountList,
            plans,
            worklogs,
        };
    }
    /**
     * Resolve accounts from team IDs and direct account IDs
     * Returns Map of accountId -> team names
     */
    async resolveAccounts(teamIds, accountIds, from, to) {
        const accounts = new Map();
        // Add direct account IDs
        for (const accountId of accountIds) {
            accounts.set(accountId, ['(individual)']);
        }
        // Resolve team members
        const rangeStart = new Date(from + 'T00:00:00Z');
        const rangeEnd = new Date(to + 'T00:00:00Z');
        for (const teamId of teamIds) {
            try {
                console.error(`  Resolving team ${teamId}...`);
                const members = await this.tempoApi.getTeamMembers(teamId);
                for (const member of members) {
                    const accountId = member.member.accountId;
                    if (!accountId)
                        continue; // Skip generic resources
                    // Check if membership overlaps with date range
                    // Note: Tempo team-memberships API doesn't return from/to dates in the current structure
                    // So we include all members
                    const teamName = member.team.name || `Team ${teamId}`;
                    if (!accounts.has(accountId)) {
                        accounts.set(accountId, []);
                    }
                    accounts.get(accountId).push(teamName);
                }
                console.error(`    Found ${members.length} members`);
            }
            catch (error) {
                console.error(`    Warning: Could not resolve team ${teamId}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return accounts;
    }
    /**
     * Fetch plans for all accounts
     */
    async fetchPlans(accountIds, from, to, teamMap) {
        console.error('  Fetching plans...');
        const allPlans = [];
        for (const accountId of accountIds) {
            try {
                const plans = await this.tempoApi.getPlans(accountId, from, to);
                for (const plan of plans) {
                    // Enrich with computed fields
                    const enriched = {
                        ...plan,
                        teams: teamMap.get(accountId) || [],
                    };
                    // Extract plannedSecondsPerDay from days.values if available
                    const days = plan.plannedTime.days?.values ?? [];
                    const workDays = days.filter(d => d.plannedSeconds > 0);
                    if (workDays.length > 0) {
                        const secondsPerDay = Math.max(...workDays.map(d => d.plannedSeconds));
                        enriched.plannedHoursPerDay = Math.round((secondsPerDay / 3600) * 100) / 100;
                        // Calculate total hours from all work days
                        const totalSeconds = workDays.reduce((sum, d) => sum + d.plannedSeconds, 0);
                        enriched.totalPlannedHours = Math.round((totalSeconds / 3600) * 100) / 100;
                    }
                    else if (plan.plannedTime.plannedSeconds) {
                        // Fallback to plannedSeconds if available
                        enriched.totalPlannedHours = Math.round((plan.plannedTime.plannedSeconds / 3600) * 100) / 100;
                    }
                    allPlans.push(enriched);
                }
            }
            catch (error) {
                console.error(`    Warning: Could not fetch plans for ${accountId}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        console.error(`    Found ${allPlans.length} plans`);
        return allPlans;
    }
    /**
     * Fetch worklogs for all accounts
     */
    async fetchWorklogs(accountIds, from, to, teamMap) {
        console.error('  Fetching worklogs...');
        const allWorklogs = [];
        for (const accountId of accountIds) {
            try {
                const worklogs = await this.tempoApi.getWorklogs(accountId, from, to);
                for (const worklog of worklogs) {
                    // Enrich with computed fields
                    const enriched = {
                        ...worklog,
                        hours: Math.round((worklog.timeSpentSeconds / 3600) * 100) / 100,
                        billableHours: worklog.billableSeconds
                            ? Math.round((worklog.billableSeconds / 3600) * 100) / 100
                            : undefined,
                        teams: teamMap.get(accountId) || [],
                    };
                    allWorklogs.push(enriched);
                }
            }
            catch (error) {
                console.error(`    Warning: Could not fetch worklogs for ${accountId}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        console.error(`    Found ${allWorklogs.length} worklogs`);
        return allWorklogs;
    }
}
//# sourceMappingURL=get-tempo-data.js.map