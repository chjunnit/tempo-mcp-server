/**
 * Tempo REST API client
 * Documentation: https://apidocs.tempo.io/
 */
export class TempoApiError extends Error {
    constructor(message, status, response) {
        super(message);
        this.status = status;
        this.response = response;
        this.name = 'TempoApiError';
    }
}
export class TempoApi {
    constructor(config) {
        this.baseUrl = config.baseUrl || 'https://api.eu.tempo.io/4';
        this.headers = {
            'Authorization': `Bearer ${config.apiToken}`,
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
                    if (errorBody.message) {
                        errorMessage += `: ${errorBody.message}`;
                    }
                }
                catch {
                    errorMessage += `: ${response.statusText}`;
                }
                throw new TempoApiError(errorMessage, response.status);
            }
            return await response.json();
        }
        catch (error) {
            if (error instanceof TempoApiError) {
                throw error;
            }
            throw new TempoApiError(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async *paginate(path, limit = 1000) {
        let nextUrl = `${path}${path.includes('?') ? '&' : '?'}limit=${limit}`;
        while (nextUrl) {
            const fullUrl = nextUrl.startsWith('http')
                ? nextUrl
                : `${this.baseUrl}${nextUrl}`;
            const response = await fetch(fullUrl, {
                method: 'GET',
                headers: this.headers,
            });
            await new Promise(resolve => setTimeout(resolve, 200));
            if (!response.ok) {
                throw new TempoApiError(`HTTP ${response.status}`, response.status);
            }
            const data = await response.json();
            if (data.results && data.results.length > 0) {
                yield data.results;
            }
            nextUrl = data.metadata?.next || null;
        }
    }
    /**
     * Get full plan details by ID
     */
    async getPlanDetails(planId, from, to) {
        let url = `/plans/${planId}`;
        if (from && to) {
            url += `?from=${from}&to=${to}`;
        }
        return await this.request('GET', url);
    }
    /**
     * Get all plans for a user in a date range
     * Fetches full plan details for each plan to get plannedSecondsPerDay
     */
    async getPlans(accountId, from, to) {
        const allPlans = [];
        // First get plan summaries
        const planSummaries = [];
        for await (const batch of this.paginate(`/plans/user/${accountId}?from=${from}&to=${to}`)) {
            planSummaries.push(...batch);
        }
        // Then fetch full details for each plan to get plannedSecondsPerDay
        for (const summary of planSummaries) {
            try {
                // Extract plan ID from metadata link if available
                let planId = summary.id;
                if (!planId && summary.plannedTime?.metadata?.all) {
                    const match = summary.plannedTime.metadata.all.match(/\/plans\/(\d+)/);
                    if (match) {
                        planId = parseInt(match[1], 10);
                    }
                }
                if (planId) {
                    // Fetch full plan details with the date range to get correct seconds
                    const fullPlan = await this.getPlanDetails(planId, summary.startDate, summary.endDate);
                    allPlans.push(fullPlan);
                }
                else {
                    console.error(`Warning: Could not extract plan ID for plan: ${JSON.stringify(summary)}`);
                    allPlans.push(summary); // Fallback to summary
                }
            }
            catch (error) {
                console.error(`Warning: Could not fetch details for plan ${summary.id}: ${error instanceof Error ? error.message : String(error)}`);
                allPlans.push(summary); // Fallback to summary
            }
        }
        return allPlans;
    }
    /**
     * Get team members
     */
    async getTeamMembers(teamId) {
        const allMembers = [];
        for await (const batch of this.paginate(`/team-memberships/team/${teamId}`)) {
            allMembers.push(...batch);
        }
        return allMembers;
    }
    /**
     * Get holidays for a user
     */
    async getHolidays(accountId, from, to) {
        const allHolidays = [];
        try {
            for await (const batch of this.paginate(`/holidays/user/${accountId}?from=${from}&to=${to}`)) {
                allHolidays.push(...batch);
            }
        }
        catch (error) {
            // Holidays endpoint may not be available for all users
            console.error(`Could not fetch holidays for ${accountId}:`, error instanceof Error ? error.message : String(error));
        }
        return allHolidays;
    }
    /**
     * Get worklogs for a user in a date range
     */
    async getWorklogs(accountId, from, to) {
        const allWorklogs = [];
        for await (const batch of this.paginate(`/worklogs/user/${accountId}?from=${from}&to=${to}`)) {
            allWorklogs.push(...batch);
        }
        return allWorklogs;
    }
    /**
     * Create a new plan
     */
    async createPlan(plan) {
        return this.request('POST', '/plans', plan);
    }
    /**
     * Delete a plan
     */
    async deletePlan(planId) {
        await this.request('DELETE', `/plans/${planId}`);
    }
}
//# sourceMappingURL=tempo-api.js.map