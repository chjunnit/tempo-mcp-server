/**
 * Copy Tempo Planner allocations from one person to others
 * Copies plans as PERIODS (not individual days), preserving includesNonWorkingDays
 */

import { TempoApi, TempoPlan, CreatePlanRequest } from '../tempo-api.js';

export interface CopyPlansArgs {
  source_account_id: string;
  target_team_id?: string;
  target_account_ids?: string[];
  from: string; // yyyy-MM-dd
  to: string; // yyyy-MM-dd
  project_ids?: number[];
  project_mapping?: Record<number, number>; // Map source project ID to target project ID
  conflict_mode?: 'Add' | 'Keep' | 'Replace';
  skip_holidays?: boolean;
  max_weekly_hours?: number;
  dry_run?: boolean;
}

export interface PlanEntry {
  startDate: string;
  endDate: string;
  projectId: number;
  projectName: string;
  projectType: 'PROJECT' | 'ISSUE';
  hours: number; // Total hours for the period
  secondsPerDay: number;
  includesNonWorkingDays: boolean;
  action: 'add' | 'replace' | 'skip';
  conflictInfo?: string;
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
  };
  targets: TargetResult[];
  totalHoursCopied: number;
  totalEntries: number;
  totalConflicts: number;
  totalSkippedHolidays: number;
  warnings: string[];
  conflictMode: string;
  writtenCount?: number;
  debug?: {
    sourcePlansRaw: any[];
    clippingLog: string[];
    clippedPlansCount: number;
  };
}

interface ClippedPlan {
  startDate: string;
  endDate: string;
  planItemId: number;
  planItemName: string;
  planItemType: 'PROJECT' | 'ISSUE';
  secondsPerDay: number;
  includesNonWorkingDays: boolean;
  totalSeconds: number;
  totalHours: number;
  sourcePlanId?: number; // Original Tempo plan ID for reference
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

    // 3. Clip plans to window and prepare for copying
    const { clippedPlans, log: clippingLog } = this.clipPlansToWindow(sourcePlans, from, to, args.project_mapping);
    console.error(`  Clipped to ${clippedPlans.length} plans within window`);

    // 4. Process each target
    const results: TargetResult[] = [];
    const globalWarnings: string[] = [];

    for (const targetId of targetAccounts) {
      console.error(`Processing target: ${targetId}`);

      const targetResult = await this.processTarget(
        targetId,
        clippedPlans,
        from,
        to,
        conflict_mode,
        skip_holidays,
        max_weekly_hours
      );

      results.push(targetResult);
      globalWarnings.push(...targetResult.warnings.map(w => `${targetId} - ${w}`));
    }

    // 5. Build summary
    const summary: CopyPlansResult = {
      action: dry_run ? 'Preview' : 'Write',
      source: {
        accountId: source_account_id,
        from,
        to,
        planCount: sourcePlans.length,
      },
      targets: results,
      totalHoursCopied: results.reduce((sum, r) => sum + r.totalHours, 0),
      totalEntries: results.reduce((sum, r) => sum + r.entries.length, 0),
      totalConflicts: results.reduce((sum, r) => sum + r.conflicts, 0),
      totalSkippedHolidays: results.reduce((sum, r) => sum + r.skippedHolidays, 0),
      warnings: globalWarnings,
      conflictMode: conflict_mode,
      debug: {
        sourcePlansRaw: sourcePlans.map(p => ({
          name: p.planItem.name,
          type: p.planItem.type,
          id: p.planItem.id,
          startDate: p.startDate,
          endDate: p.endDate,
          plannedTime: p.plannedTime,
          includesNonWorkingDays: p.includesNonWorkingDays
        })),
        clippingLog,
        clippedPlansCount: clippedPlans.length
      }
    };

    // 6. Execute write if requested
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

  /**
   * Clip plans to the window [from, to] and calculate seconds for the clipped period
   * Preserves includesNonWorkingDays flag from source
   * Applies project mapping if specified
   */
  private clipPlansToWindow(
    plans: TempoPlan[],
    windowFrom: string,
    windowTo: string,
    projectMapping?: Record<number, number>
  ): { clippedPlans: ClippedPlan[]; log: string[] } {
    const clippedPlans: ClippedPlan[] = [];
    const log: string[] = [];
    const windowStart = new Date(windowFrom + 'T00:00:00Z');
    const windowEnd = new Date(windowTo + 'T00:00:00Z');

    log.push(`\n=== Clipping ${plans.length} source plans to window ${windowFrom} - ${windowTo} ===`);
    console.error(`\n=== Clipping ${plans.length} source plans to window ${windowFrom} - ${windowTo} ===`);

    for (const plan of plans) {
      // Extract plan ID from metadata if available
      let planId = plan.id;
      if (!planId && plan.plannedTime.metadata?.all) {
        const match = plan.plannedTime.metadata.all.match(/\/plans\/(\d+)/);
        if (match) {
          planId = parseInt(match[1], 10);
        }
      }

      // Log raw plan for debugging
      const planIdStr = planId ? ` [Plan #${planId}]` : '';
      const planInfo = `\nProcessing plan: ${plan.planItem.name} (${plan.planItem.type} #${plan.planItem.id})${planIdStr}`;
      log.push(planInfo);
      console.error(planInfo);

      const periodInfo = `  Period: ${plan.startDate} to ${plan.endDate}`;
      log.push(periodInfo);
      console.error(periodInfo);

      const timeInfo = `  plannedTime: ${JSON.stringify(plan.plannedTime)}`;
      log.push(timeInfo);
      console.error(timeInfo);

      const nonWorkingInfo = `  includesNonWorkingDays: ${plan.includesNonWorkingDays}`;
      log.push(nonWorkingInfo);
      console.error(nonWorkingInfo);

      const planStart = new Date(plan.startDate + 'T00:00:00Z');
      const planEnd = new Date(plan.endDate + 'T00:00:00Z');

      // Clip plan to window
      const effectiveStart = planStart > windowStart ? planStart : windowStart;
      const effectiveEnd = planEnd < windowEnd ? planEnd : windowEnd;

      // Skip if plan doesn't overlap window
      if (effectiveStart > windowEnd || effectiveEnd < windowStart) {
        const skipMsg = `  → SKIPPED: Outside window`;
        log.push(skipMsg);
        console.error(skipMsg);
        continue;
      }

      // Extract secondsPerDay from Tempo's nested structure
      let secondsPerDay = plan.plannedTime.plannedSecondsPerDay;

      if (!secondsPerDay) {
        // Try to get from days.values (actual API response format)
        const days = plan.plannedTime.days?.values ?? [];
        const workDays = days.filter(d => d.plannedSeconds > 0);

        if (workDays.length > 0) {
          // Use max to get standard working day (excludes holidays/weekends which are 0)
          secondsPerDay = Math.max(...workDays.map(d => d.plannedSeconds));
          const calcMsg = `  → Extracted secondsPerDay from days: ${secondsPerDay} (${workDays.length} work days)`;
          log.push(calcMsg);
          console.error(calcMsg);
        } else {
          // Fallback: try to calculate from total plannedSeconds
          const originalDays = this.countDays(planStart, planEnd);
          const plannedSeconds = plan.plannedTime.plannedSeconds ?? 0;

          if (originalDays > 0 && plannedSeconds > 0) {
            secondsPerDay = Math.round(plannedSeconds / originalDays);
            const calcMsg = `  → Calculated secondsPerDay: ${secondsPerDay} (${plannedSeconds}s / ${originalDays} days)`;
            log.push(calcMsg);
            console.error(calcMsg);
          } else {
            const skipMsg = `  → SKIPPED: No plannedSecondsPerDay, no days data, cannot calculate (plannedSeconds: ${plannedSeconds}, originalDays: ${originalDays}, days: ${days.length})`;
            log.push(skipMsg);
            console.error(skipMsg);
            continue;
          }
        }
      }

      if (secondsPerDay === 0) {
        const skipMsg = `  → SKIPPED: secondsPerDay is 0`;
        log.push(skipMsg);
        console.error(skipMsg);
        continue;
      }

      // Calculate actual working hours in clipped period
      // Use days.values to count only work days (excludes weekends/holidays)
      const clippedStartStr = effectiveStart.toISOString().split('T')[0];
      const clippedEndStr = effectiveEnd.toISOString().split('T')[0];

      let totalSeconds = 0;
      let workDaysInRange = 0;

      const allDays = plan.plannedTime.days?.values ?? [];
      if (allDays.length > 0) {
        // Count actual work days in clipped range
        for (const day of allDays) {
          if (day.date >= clippedStartStr && day.date <= clippedEndStr && day.plannedSeconds > 0) {
            totalSeconds += day.plannedSeconds;
            workDaysInRange++;
          }
        }
      }

      // Fallback if no days data: use secondsPerDay × calendar days
      if (totalSeconds === 0) {
        const clippedDays = this.countDays(effectiveStart, effectiveEnd);
        totalSeconds = secondsPerDay * clippedDays;
        workDaysInRange = clippedDays;
      }

      const totalHours = Math.round((totalSeconds / 3600) * 100) / 100;

      // Apply project mapping if specified
      const targetProjectId = projectMapping?.[plan.planItem.id] ?? plan.planItem.id;
      const wasMapped = targetProjectId !== plan.planItem.id;

      const clipMsg = `  → Clipped: ${clippedStartStr} to ${clippedEndStr} (${workDaysInRange} work days, ${totalHours}h total)`;
      log.push(clipMsg);
      console.error(clipMsg);

      if (wasMapped) {
        const mapMsg = `  → Project mapped: ${plan.planItem.id} → ${targetProjectId}`;
        log.push(mapMsg);
        console.error(mapMsg);
      }

      clippedPlans.push({
        startDate: clippedStartStr,
        endDate: clippedEndStr,
        planItemId: targetProjectId,
        planItemName: plan.planItem.name, // Keep original name even when mapped
        planItemType: plan.planItem.type,
        secondsPerDay: secondsPerDay,
        includesNonWorkingDays: plan.includesNonWorkingDays || false,
        totalSeconds: totalSeconds,
        totalHours: totalHours,
        sourcePlanId: planId,
      });
    }

    const resultMsg = `\n=== Clipping result: ${clippedPlans.length} plans to copy ===\n`;
    log.push(resultMsg);
    console.error(resultMsg);

    return { clippedPlans, log };
  }

  private countDays(start: Date, end: Date): number {
    const diffTime = end.getTime() - start.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1; // +1 to include both start and end
  }

  private async processTarget(
    targetId: string,
    clippedPlans: ClippedPlan[],
    from: string,
    to: string,
    conflictMode: string,
    skipHolidays: boolean,
    maxWeeklyHours: number
  ): Promise<TargetResult> {
    // Fetch existing plans for this target within the window
    const existingPlans = await this.tempoApi.getPlans(targetId, from, to);

    // Build conflict map: for each plan item (type + id), track date ranges
    const existingRanges = new Map<string, Array<{ start: Date; end: Date; plan: TempoPlan }>>();

    for (const existing of existingPlans) {
      const key = `${existing.planItem.type}|${existing.planItem.id}`;
      if (!existingRanges.has(key)) {
        existingRanges.set(key, []);
      }
      existingRanges.get(key)!.push({
        start: new Date(existing.startDate + 'T00:00:00Z'),
        end: new Date(existing.endDate + 'T00:00:00Z'),
        plan: existing,
      });
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

    for (const sourcePlan of clippedPlans) {
      const key = `${sourcePlan.planItemType}|${sourcePlan.planItemId}`;
      const existingForItem = existingRanges.get(key) || [];

      // Check if this plan overlaps with any existing plans for same item
      const planStart = new Date(sourcePlan.startDate + 'T00:00:00Z');
      const planEnd = new Date(sourcePlan.endDate + 'T00:00:00Z');

      const overlaps = existingForItem.filter(e => {
        // Two ranges overlap if: start1 <= end2 AND start2 <= end1
        return planStart <= e.end && e.start <= planEnd;
      });

      let action: 'add' | 'replace' | 'skip' = 'add';
      let conflictInfo: string | undefined = undefined;

      if (overlaps.length > 0) {
        result.conflicts++;
        const overlapSummary = overlaps.map(o =>
          `${o.plan.startDate} to ${o.plan.endDate}`
        ).join(', ');
        conflictInfo = `Overlaps with existing: ${overlapSummary}`;

        switch (conflictMode) {
          case 'Keep':
            action = 'skip';
            break;
          case 'Replace':
            action = 'replace';
            result.warnings.push(`Replace mode: Manual deletion required for ${sourcePlan.planItemName} (${overlapSummary})`);
            break;
          case 'Add':
            action = 'add';
            break;
        }
      }

      // Check if entire period is holidays (only relevant if skipHolidays is true)
      let allHolidays = false;
      if (skipHolidays && holidays.size > 0) {
        allHolidays = true;
        for (let d = new Date(planStart); d <= planEnd; d.setUTCDate(d.getUTCDate() + 1)) {
          const dateStr = d.toISOString().split('T')[0];
          if (!holidays.has(dateStr)) {
            allHolidays = false;
            break;
          }
        }

        if (allHolidays) {
          result.skippedHolidays++;
          action = 'skip';
          conflictInfo = 'Entire period is holidays/vacation';
        }
      }

      if (action !== 'skip') {
        const entry: PlanEntry = {
          startDate: sourcePlan.startDate,
          endDate: sourcePlan.endDate,
          projectId: sourcePlan.planItemId,
          projectName: sourcePlan.planItemName,
          projectType: sourcePlan.planItemType,
          hours: sourcePlan.totalHours,
          secondsPerDay: sourcePlan.secondsPerDay,
          includesNonWorkingDays: sourcePlan.includesNonWorkingDays,
          action,
          conflictInfo,
        };

        result.entries.push(entry);
        result.totalHours += sourcePlan.totalHours;
      }
    }

    // Weekly validation - estimate based on average 5 working days per week
    const avgWeeklyHours = result.totalHours / this.countWeeks(from, to);
    if (avgWeeklyHours > maxWeeklyHours) {
      const warning = `Average ${Math.round(avgWeeklyHours)}h/week exceeds max ${maxWeeklyHours}h/week`;
      result.warnings.push(warning);
    }

    return result;
  }

  private countWeeks(from: string, to: string): number {
    const start = new Date(from + 'T00:00:00Z');
    const end = new Date(to + 'T00:00:00Z');
    const diffTime = end.getTime() - start.getTime();
    const diffDays = diffTime / (1000 * 60 * 60 * 24);
    return Math.max(1, diffDays / 7); // At least 1 week
  }

  private async writePlans(results: TargetResult[], summary: CopyPlansResult): Promise<number> {
    let written = 0;

    for (const targetResult of results) {
      for (const entry of targetResult.entries) {
        if (entry.action === 'replace') {
          console.error(`  Skipping replace action - manual deletion required first`);
          continue;
        }

        try {
          // Convert planItemId to correct type: string for ISSUE, number for PROJECT
          const planItemId = entry.projectType === 'ISSUE'
            ? String(entry.projectId)
            : entry.projectId;

          const planRequest: CreatePlanRequest = {
            assigneeId: targetResult.accountId,
            assigneeType: 'USER',
            planItemId: planItemId,
            planItemType: entry.projectType as 'PROJECT' | 'ISSUE',
            startDate: entry.startDate,
            endDate: entry.endDate,
            plannedSecondsPerDay: entry.secondsPerDay,
            includeNonWorkingDays: entry.includesNonWorkingDays,
            rule: 'NEVER', // Don't recalculate on holidays/schedule changes
          };

          console.error(`  Writing plan: ${entry.projectName} (${entry.projectType} #${entry.projectId}) ${entry.startDate} to ${entry.endDate} for ${targetResult.accountId}`);
          await this.tempoApi.createPlan(planRequest);
          written++;
          console.error(`  ✓ Written successfully`);
        } catch (error) {
          const err = `Failed to write ${entry.startDate}-${entry.endDate} ${entry.projectName} (${entry.projectType} #${entry.projectId}) for ${targetResult.accountId}: ${error instanceof Error ? error.message : String(error)}`;
          summary.warnings.push(err);
          console.error(`  ✗ ERROR: ${err}`);
        }
      }
    }

    return written;
  }
}
