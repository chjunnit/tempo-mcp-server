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
  startDate: string; // yyyy-MM-dd
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
  date: string; // yyyy-MM-dd
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
   * Get all plans for a user in a date range
   */
  async getPlans(accountId: string, from: string, to: string): Promise<TempoPlan[]> {
    const allPlans: TempoPlan[] = [];

    for await (const batch of this.paginate<TempoPlan>(
      `/plans/user/${accountId}?from=${from}&to=${to}`
    )) {
      allPlans.push(...batch);
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
