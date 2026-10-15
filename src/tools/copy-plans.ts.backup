/**
 * Copy Tempo Planner allocations from one person to others
 */

import { TempoApi, TempoPlan } from '../tempo-api.js';

export interface CopyPlansArgs {
  source_account_id: string;
  target_team_id?: string;
  target_account_ids?: string[];
  from: string; // yyyy-MM-dd
  to: string; // yyyy-MM-dd
  project_ids?: number[];
  conflict_mode?: 'Add' | 'Keep' | 'Replace';
  skip_holidays?: boolean;
  max_weekly_hours?: number;
  dry_run?: boolean;
}

export interface PlanEntry {
  date: string;
  projectId: number;
  projectName: string;
  hours: number;
  action: 'add' | 'replace' | 'skip';
  existingHours: number;
  newTotalHours: number;
  plannedSeconds: number;
}

export interface TargetResult {
  accountId: string;
  entries: PlanEntry[];
  totalHours: number;
  skippedHolidays: number;
  conflicts: number;
  warnings: string[];
}

export interface CopyPlansResult {
  action: 'Preview' | 'Write';
  source: {
    accountId: string;
    from: string;
    to: string;
    planCount: number;
    dateCount: number;
  };
  targets: TargetResult[];
  totalHoursCopied: number;
  totalEntries: number;
  totalConflicts: number;
  totalSkippedHolidays: number;
  warnings: string[];
  conflictMode: string;
  writtenCount?: number;
}

export class CopyPlansService {
  constructor(private tempoApi: TempoApi) {}

  async execute(args: CopyPlansArgs): Promise<CopyPlansResult> {
    const {
      source_account_id,
      target_team_id,
      target_account_ids = [],
      from,
      to,
      project_ids = [],
      conflict_mode = 'Add',
      skip_holidays = true,
      max_weekly_hours = 40,
      dry_run = true,
    } = args;

    console.error('=== Copy Tempo Plans:', dry_run ? 'Preview' : 'Write', 'mode ===');
    console.error(`Source: ${source_account_id}, Period: ${from} to ${to}`);

    // 1. Resolve target accounts
    const targetAccounts = await this.resolveTargets(target_team_id, target_account_ids);

    if (targetAccounts.length === 0) {
      throw new Error('No target accounts specified. Provide either target_team_id or target_account_ids.');
    }

    console.error(`Targets: ${targetAccounts.length} accounts`);

    // 2. Fetch source plans
    console.error('Fetching source plans...');
    let sourcePlans = await this.tempoApi.getPlans(source_account_id, from, to);

    if (sourcePlans.length === 0) {
      throw new Error(`No plans found for source account ${source_account_id} in period ${from} to ${to}`);
    }

    // Filter by projects if specified
    if (project_ids.length > 0) {
      sourcePlans = sourcePlans.filter(plan => project_ids.includes(plan.planItem.id));
      console.error(`  Filtered to ${sourcePlans.length} plans matching project IDs`);
    }

    console.error(`  Found ${sourcePlans.length} source plan entries`);

    // Group by date
    const plansByDate = this.groupPlansByDate(sourcePlans);
    console.error(`  Covering ${Object.keys(plansByDate).length} unique dates`);

    // 3. Process each target
    const results: TargetResult[] = [];
    const globalWarnings: string[] = [];

    for (const targetId of targetAccounts) {
      console.error(`Processing target: ${targetId}`);

      const targetResult = await this.processTarget(
        targetId,
        plansByDate,
        from,
        to,
        conflict_mode,
        skip_holidays,
        max_weekly_hours
      );

      results.push(targetResult);
      globalWarnings.push(...targetResult.warnings.map(w => `${targetId} - ${w}`));
    }

    // 4. Build summary
    const summary: CopyPlansResult = {
      action: dry_run ? 'Preview' : 'Write',
      source: {
        accountId: source_account_id,
        from,
        to,
        planCount: sourcePlans.length,
        dateCount: Object.keys(plansByDate).length,
      },
      targets: results,
      totalHoursCopied: results.reduce((sum, r) => sum + r.totalHours, 0),
      totalEntries: results.reduce((sum, r) => sum + r.entries.length, 0),
      totalConflicts: results.reduce((sum, r) => sum + r.conflicts, 0),
      totalSkippedHolidays: results.reduce((sum, r) => sum + r.skippedHolidays, 0),
      warnings: globalWarnings,
      conflictMode: conflict_mode,
    };

    // 5. Execute write if requested
    if (!dry_run) {
      console.error('Writing plans to Tempo API...');
      const writtenCount = await this.writePlans(results, summary);
      summary.writtenCount = writtenCount;
      console.error(`Successfully wrote ${writtenCount} plan entries`);
    }

    return summary;
  }

  private async resolveTargets(
    teamId: string | undefined,
    accountIds: string[]
  ): Promise<string[]> {
    const targets: Set<string> = new Set();

    if (teamId) {
      console.error(`Resolving team ${teamId} members...`);
      const members = await this.tempoApi.getTeamMembers(parseInt(teamId, 10));
      for (const member of members) {
        targets.add(member.member.accountId);
      }
      console.error(`  Found ${members.length} team members`);
    }

    for (const id of accountIds) {
      targets.add(id);
    }

    if (accountIds.length > 0) {
      console.error(`  Added ${accountIds.length} individual accounts`);
    }

    return Array.from(targets);
  }

  private groupPlansByDate(plans: TempoPlan[]): Record<string, TempoPlan[]> {
    const grouped: Record<string, TempoPlan[]> = {};

    for (const plan of plans) {
      const date = plan.startDate;
      if (!grouped[date]) {
        grouped[date] = [];
      }
      grouped[date].push(plan);
    }

    return grouped;
  }

  private async processTarget(
    targetId: string,
    plansByDate: Record<string, TempoPlan[]>,
    from: string,
    to: string,
    conflictMode: string,
    skipHolidays: boolean,
    maxWeeklyHours: number
  ): Promise<TargetResult> {
    // Fetch existing plans
    const existingPlans = await this.tempoApi.getPlans(targetId, from, to);

    // Group existing by date + project
    const existingByDateProject = new Map<string, TempoPlan[]>();
    for (const plan of existingPlans) {
      const key = `${plan.startDate}|${plan.planItem.id}`;
      if (!existingByDateProject.has(key)) {
        existingByDateProject.set(key, []);
      }
      existingByDateProject.get(key)!.push(plan);
    }

    // Fetch holidays if needed
    const holidays = new Set<string>();
    if (skipHolidays) {
      try {
        const holidayData = await this.tempoApi.getHolidays(targetId, from, to);
        for (const h of holidayData) {
          holidays.add(h.date);
        }
        if (holidays.size > 0) {
          console.error(`  Found ${holidays.size} holiday/vacation days`);
        }
      } catch (error) {
        console.error(`  Warning: Could not fetch holidays - ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Calculate what to copy
    const result: TargetResult = {
      accountId: targetId,
      entries: [],
      totalHours: 0,
      skippedHolidays: 0,
      conflicts: 0,
      warnings: [],
    };

    for (const [date, sourcePlansForDate] of Object.entries(plansByDate)) {
      // Skip holidays
      if (holidays.has(date)) {
        result.skippedHolidays++;
        continue;
      }

      for (const sourcePlan of sourcePlansForDate) {
        const projectId = sourcePlan.planItem.id;
        const projectName = sourcePlan.planItem.name;
        const sourceSeconds = sourcePlan.plannedTime.plannedSeconds;
        const sourceHours = Math.round((sourceSeconds / 3600) * 100) / 100;

        const key = `${date}|${projectId}`;
        const existingForDateProject = existingByDateProject.get(key);

        let action: 'add' | 'replace' | 'skip' = 'add';
        let newSeconds = sourceSeconds;
        let existingHours = 0;

        if (existingForDateProject && existingForDateProject.length > 0) {
          result.conflicts++;
          existingHours = Math.round(
            (existingForDateProject.reduce((sum, p) => sum + p.plannedTime.plannedSeconds, 0) / 3600) * 100
          ) / 100;

          switch (conflictMode) {
            case 'Keep':
              action = 'skip';
              newSeconds = 0;
              break;
            case 'Replace':
              action = 'replace';
              newSeconds = sourceSeconds;
              break;
            case 'Add':
              action = 'add';
              newSeconds = sourceSeconds;
              break;
          }
        }

        if (action !== 'skip') {
          const entry: PlanEntry = {
            date,
            projectId,
            projectName,
            hours: sourceHours,
            action,
            existingHours,
            newTotalHours: Math.round(((existingHours * 3600 + newSeconds) / 3600) * 100) / 100,
            plannedSeconds: newSeconds,
          };

          result.entries.push(entry);
          result.totalHours += sourceHours;
        }
      }
    }

    // Weekly validation
    const weeklyTotals = this.calculateWeeklyTotals(result.entries);
    for (const [week, hours] of Object.entries(weeklyTotals)) {
      if (hours > maxWeeklyHours) {
        const warning = `Week ${week}: ${hours}h exceeds max ${maxWeeklyHours}h`;
        result.warnings.push(warning);
      }
    }

    return result;
  }

  private calculateWeeklyTotals(entries: PlanEntry[]): Record<string, number> {
    const totals: Record<string, number> = {};

    for (const entry of entries) {
      const date = new Date(entry.date);
      // Get Monday of the week (ISO week)
      const dayOfWeek = date.getDay();
      const diff = date.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
      const monday = new Date(date.setDate(diff));
      const weekStart = monday.toISOString().split('T')[0];

      if (!totals[weekStart]) {
        totals[weekStart] = 0;
      }
      totals[weekStart] += entry.newTotalHours;
    }

    return totals;
  }

  private async writePlans(results: TargetResult[], summary: CopyPlansResult): Promise<number> {
    let written = 0;

    for (const targetResult of results) {
      for (const entry of targetResult.entries) {
        if (entry.action === 'replace') {
          console.error(`  Warning: Replace mode requires manual deletion of existing plans`);
        }

        try {
          await this.tempoApi.createPlan({
            assignee: { accountId: targetResult.accountId },
            planItem: { id: entry.projectId },
            startDate: entry.date,
            endDate: entry.date,
            plannedSeconds: entry.plannedSeconds,
          });
          written++;
        } catch (error) {
          const err = `Failed to write ${entry.date} for ${targetResult.accountId}: ${error instanceof Error ? error.message : String(error)}`;
          summary.warnings.push(err);
          console.error(`  ERROR: ${err}`);
        }
      }
    }

    return written;
  }
}
