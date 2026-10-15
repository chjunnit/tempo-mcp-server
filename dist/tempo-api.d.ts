/**
 * Tempo REST API client
 * Documentation: https://apidocs.tempo.io/
 */
export interface TempoConfig {
    apiToken: string;
    baseUrl?: string;
}
export interface TempoPlan {
    id?: number;
    assignee: {
        accountId: string;
        displayName?: string;
    };
    planItem: {
        id: number;
        name: string;
        type: 'PROJECT' | 'ISSUE';
    };
    startDate: string;
    endDate: string;
    plannedTime: {
        plannedSeconds?: number;
        plannedSecondsPerDay?: number;
        periods?: {
            values?: Array<{
                from: string;
                to: string;
                plannedSeconds: number;
            }>;
        };
        days?: {
            values?: Array<{
                date: string;
                plannedSeconds: number;
            }>;
        };
        metadata?: {
            all?: string;
        };
    };
    includesNonWorkingDays?: boolean;
}
export interface TempoTeamMember {
    member: {
        accountId: string;
        displayName?: string;
    };
    team: {
        id: number;
        name: string;
    };
}
export interface TempoHoliday {
    date: string;
    name?: string;
    type?: string;
}
export interface TempoWorklog {
    tempoWorklogId: number;
    issue: {
        id: number;
        key: string;
    };
    timeSpentSeconds: number;
    billableSeconds?: number;
    startDate: string;
    startTime?: string;
    description?: string;
    createdAt: string;
    updatedAt: string;
    author: {
        accountId: string;
        displayName?: string;
    };
    attributes?: {
        key: string;
        value: string;
    }[];
}
export interface CreatePlanRequest {
    assigneeId: string;
    assigneeType: 'USER';
    planItemId: number | string;
    planItemType: 'PROJECT' | 'ISSUE';
    startDate: string;
    endDate: string;
    plannedSecondsPerDay: number;
    includeNonWorkingDays: boolean;
    rule: 'FIXED' | 'SPLIT_EVENLY' | 'NEVER';
}
export declare class TempoApiError extends Error {
    status?: number | undefined;
    response?: unknown | undefined;
    constructor(message: string, status?: number | undefined, response?: unknown | undefined);
}
export declare class TempoApi {
    private baseUrl;
    private headers;
    constructor(config: TempoConfig);
    private request;
    private paginate;
    /**
     * Get full plan details by ID
     */
    getPlanDetails(planId: number, from?: string, to?: string): Promise<TempoPlan>;
    /**
     * Get all plans for a user in a date range
     * Fetches full plan details for each plan to get plannedSecondsPerDay
     */
    getPlans(accountId: string, from: string, to: string): Promise<TempoPlan[]>;
    /**
     * Get team members
     */
    getTeamMembers(teamId: number): Promise<TempoTeamMember[]>;
    /**
     * Get holidays for a user
     */
    getHolidays(accountId: string, from: string, to: string): Promise<TempoHoliday[]>;
    /**
     * Get worklogs for a user in a date range
     */
    getWorklogs(accountId: string, from: string, to: string): Promise<TempoWorklog[]>;
    /**
     * Create a new plan
     */
    createPlan(plan: CreatePlanRequest): Promise<TempoPlan>;
    /**
     * Delete a plan
     */
    deletePlan(planId: number): Promise<void>;
}
//# sourceMappingURL=tempo-api.d.ts.map