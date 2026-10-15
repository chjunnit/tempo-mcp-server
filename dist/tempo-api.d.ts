/**
 * Tempo REST API client
 * Documentation: https://apidocs.tempo.io/
 */
export interface TempoConfig {
    apiToken: string;
    baseUrl?: string;
}
export interface TempoPlan {
    id: number;
    assignee: {
        accountId: string;
        displayName?: string;
    };
    planItem: {
        id: number;
        name: string;
        type: string;
    };
    startDate: string;
    endDate: string;
    plannedTime: {
        plannedSeconds: number;
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
export interface CreatePlanRequest {
    assignee: {
        accountId: string;
    };
    planItem: {
        id: number;
    };
    startDate: string;
    endDate: string;
    plannedSeconds: number;
    includesNonWorkingDays?: boolean;
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
     * Get all plans for a user in a date range
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
     * Create a new plan
     */
    createPlan(plan: CreatePlanRequest): Promise<TempoPlan>;
    /**
     * Delete a plan
     */
    deletePlan(planId: number): Promise<void>;
}
//# sourceMappingURL=tempo-api.d.ts.map