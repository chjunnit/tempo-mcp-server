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
  startDate: string; // yyyy-MM-dd
  endDate: string;
  plannedTime: {
    // Legacy flat structure (rarely used)
    plannedSeconds?: number;
    plannedSecondsPerDay?: number;
    // Actual structure returned by API
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
      all?: string; // Link to full plan details
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
  date: string; // yyyy-MM-dd
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
  startDate: string; // yyyy-MM-dd
  startTime?: string; // HH:mm:ss
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
  planItemId: number | string; // number for PROJECT, string for ISSUE
  planItemType: 'PROJECT' | 'ISSUE';
  startDate: string;
  endDate: string;
  plannedSecondsPerDay: number;
  includeNonWorkingDays: boolean;
  rule: 'FIXED' | 'SPLIT_EVENLY' | 'NEVER';
}

export class TempoApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public response?: unknown
  ) {
    super(message);
    this.name = 'TempoApiError';
  }
}

export class TempoApi {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: TempoConfig) {
    this.baseUrl = config.baseUrl || 'https://api.eu.tempo.io/4';
    this.headers = {
      'Authorization': `Bearer ${config.apiToken}`,
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
          const errorBody = await response.json() as { message?: string };
          if (errorBody.message) {
            errorMessage += `: ${errorBody.message}`;
          }
        } catch {
          errorMessage += `: ${response.statusText}`;
        }
        throw new TempoApiError(errorMessage, response.status);
      }

      return await response.json() as T;
    } catch (error) {
      if (error instanceof TempoApiError) {
        throw error;
      }
      throw new TempoApiError(
        `Request failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async *paginate<T>(
    path: string,
    limit = 1000
  ): AsyncGenerator<T[], void, undefined> {
    let nextUrl: string | null = `${path}${path.includes('?') ? '&' : '?'}limit=${limit}`;

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

      const data = await response.json() as { results?: T[]; metadata?: { next?: string } };

      if (data.results && data.results.length > 0) {
        yield data.results;
      }

      nextUrl = data.metadata?.next || null;
    }
  }

  /**
   * Get full plan details by ID
   */
  async getPlanDetails(planId: number, from?: string, to?: string): Promise<TempoPlan> {
    let url = `/plans/${planId}`;
    if (from && to) {
      url += `?from=${from}&to=${to}`;
    }
    return await this.request<TempoPlan>('GET', url);
  }

  /**
   * Get all plans for a user in a date range
   * Fetches full plan details for each plan to get plannedSecondsPerDay
   */
  async getPlans(accountId: string, from: string, to: string): Promise<TempoPlan[]> {
    const allPlans: TempoPlan[] = [];

    // First get plan summaries
    const planSummaries: TempoPlan[] = [];
    for await (const batch of this.paginate<TempoPlan>(
      `/plans/user/${accountId}?from=${from}&to=${to}`
    )) {
      planSummaries.push(...batch);
    }

    // Then fetch full details for each plan to get plannedSecondsPerDay
    for (const summary of planSummaries) {
      try {
        // Extract plan ID from metadata link if available
        let planId = summary.id;
        if (!planId && (summary.plannedTime as any)?.metadata?.all) {
          const match = ((summary.plannedTime as any).metadata.all as string).match(/\/plans\/(\d+)/);
          if (match) {
            planId = parseInt(match[1], 10);
          }
        }

        if (planId) {
          // Fetch full plan details with the date range to get correct seconds
          const fullPlan = await this.getPlanDetails(planId, summary.startDate, summary.endDate);
          allPlans.push(fullPlan);
        } else {
          console.error(`Warning: Could not extract plan ID for plan: ${JSON.stringify(summary)}`);
          allPlans.push(summary); // Fallback to summary
        }
      } catch (error) {
        console.error(`Warning: Could not fetch details for plan ${summary.id}: ${error instanceof Error ? error.message : String(error)}`);
        allPlans.push(summary); // Fallback to summary
      }
    }

    return allPlans;
  }

  /**
   * Get team members
   */
  async getTeamMembers(teamId: number): Promise<TempoTeamMember[]> {
    const allMembers: TempoTeamMember[] = [];

    for await (const batch of this.paginate<TempoTeamMember>(
      `/team-memberships/team/${teamId}`
    )) {
      allMembers.push(...batch);
    }

    return allMembers;
  }

  /**
   * Get holidays for a user
   */
  async getHolidays(accountId: string, from: string, to: string): Promise<TempoHoliday[]> {
    const allHolidays: TempoHoliday[] = [];

    try {
      for await (const batch of this.paginate<TempoHoliday>(
        `/holidays/user/${accountId}?from=${from}&to=${to}`
      )) {
        allHolidays.push(...batch);
      }
    } catch (error) {
      // Holidays endpoint may not be available for all users
      console.error(`Could not fetch holidays for ${accountId}:`, error instanceof Error ? error.message : String(error));
    }

    return allHolidays;
  }

  /**
   * Get worklogs for a user in a date range
   */
  async getWorklogs(accountId: string, from: string, to: string): Promise<TempoWorklog[]> {
    const allWorklogs: TempoWorklog[] = [];

    for await (const batch of this.paginate<TempoWorklog>(
      `/worklogs/user/${accountId}?from=${from}&to=${to}`
    )) {
      allWorklogs.push(...batch);
    }

    return allWorklogs;
  }

  /**
   * Create a new plan
   */
  async createPlan(plan: CreatePlanRequest): Promise<TempoPlan> {
    return this.request<TempoPlan>('POST', '/plans', plan);
  }

  /**
   * Delete a plan
   */
  async deletePlan(planId: number): Promise<void> {
    await this.request('DELETE', `/plans/${planId}`);
  }
}
