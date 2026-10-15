/**
 * Get Tempo plans and/or worklogs for teams and individuals
 */
import { TempoApi, TempoPlan, TempoWorklog } from '../tempo-api.js';
export interface GetTempoDataArgs {
    from: string;
    to: string;
    team_ids?: number[];
    account_ids?: string[];
    data_type?: 'Plans' | 'Worklogs' | 'Both';
}
export interface TempoDataResult {
    from: string;
    to: string;
    accounts: string[];
    plans?: EnrichedPlan[];
    worklogs?: EnrichedWorklog[];
}
export interface EnrichedPlan extends TempoPlan {
    plannedHoursPerDay?: number;
    totalPlannedHours?: number;
    teams?: string[];
}
export interface EnrichedWorklog extends TempoWorklog {
    hours?: number;
    billableHours?: number;
    teams?: string[];
}
export declare class GetTempoDataService {
    private tempoApi;
    constructor(tempoApi: TempoApi);
    execute(args: GetTempoDataArgs): Promise<TempoDataResult>;
    /**
     * Resolve accounts from team IDs and direct account IDs
     * Returns Map of accountId -> team names
     */
    private resolveAccounts;
    /**
     * Fetch plans for all accounts
     */
    private fetchPlans;
    /**
     * Fetch worklogs for all accounts
     */
    private fetchWorklogs;
}
//# sourceMappingURL=get-tempo-data.d.ts.map