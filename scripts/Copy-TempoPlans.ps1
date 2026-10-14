<#
.SYNOPSIS
    Copy Tempo Planner allocations from one person to others.

.DESCRIPTION
    Fetches source person's plans and copies them to target accounts.
    Supports dry-run preview and actual write with conflict handling.

.PARAMETER Action
    Preview or Write

.PARAMETER SourceAccountId
    Atlassian account ID to copy from

.PARAMETER TargetTeamId
    Optional: Tempo team ID to copy to all members

.PARAMETER TargetAccountIds
    Optional: Comma-separated account IDs

.PARAMETER From
    Start date (yyyy-MM-dd)

.PARAMETER To
    End date (yyyy-MM-dd)

.PARAMETER ProjectIds
    Optional: Comma-separated project IDs to filter

.PARAMETER ConflictMode
    How to handle existing allocations: Add, Keep, or Replace

.PARAMETER SkipHolidays
    Skip days where target has holiday/vacation (default: true)

.PARAMETER MaxWeeklyHours
    Warn if weekly total exceeds this (default: 40)

.PARAMETER BaseUrl
    Tempo API base URL (default: https://api.eu.tempo.io/4)
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [ValidateSet('Preview', 'Write')] [string] $Action,
    [Parameter(Mandatory)] [string] $SourceAccountId,
    [string] $TargetTeamId = '',
    [string] $TargetAccountIds = '',
    [Parameter(Mandatory)] [string] $From,
    [Parameter(Mandatory)] [string] $To,
    [string] $ProjectIds = '',
    [ValidateSet('Add', 'Keep', 'Replace')] [string] $ConflictMode = 'Add',
    [bool] $SkipHolidays = $true,
    [int] $MaxWeeklyHours = 40,
    [string] $BaseUrl = 'https://api.eu.tempo.io/4'
)

$ErrorActionPreference = 'Stop'

# ---------- Configuration ----------
$tempoToken = $env:TEMPO_API_TOKEN
if ([string]::IsNullOrWhiteSpace($tempoToken)) {
    throw "TEMPO_API_TOKEN environment variable must be set"
}

$headers = @{
    Authorization = "Bearer $tempoToken"
    Accept = 'application/json'
}

# ---------- HTTP helper ----------
function Invoke-TempoApi {
    param(
        [string] $Method,
        [string] $Url,
        $Body = $null
    )

    try {
        $params = @{
            Method = $Method
            Uri = $Url
            Headers = $headers
            UseBasicParsing = $true
        }

        if ($null -ne $Body) {
            $json = ConvertTo-Json -InputObject $Body -Depth 10 -Compress
            $params.Body = [Text.Encoding]::UTF8.GetBytes($json)
            $params.ContentType = 'application/json; charset=utf-8'
        }

        $resp = Invoke-WebRequest @params
        $text = [Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
        Start-Sleep -Milliseconds 200

        return ($text | ConvertFrom-Json)
    }
    catch {
        $status = $null
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }

        $errorMsg = "HTTP $status for $Url"
        try {
            $errorBody = $_.ErrorDetails.Message | ConvertFrom-Json
            if ($errorBody.message) {
                $errorMsg += ": " + $errorBody.message
            }
        } catch {
            $errorMsg += ": " + $_.Exception.Message
        }
        throw $errorMsg
    }
}

# ---------- Pagination helper ----------
function Get-AllPages {
    param([string] $Url)

    $all = @()
    $next = $Url

    while ($next) {
        $page = Invoke-TempoApi -Method GET -Url $next
        if ($page.results) { $all += $page.results }
        $next = $null
        if ($page.metadata -and $page.metadata.next) { $next = $page.metadata.next }
    }

    return $all
}

[Console]::Error.WriteLine("=== Copy Tempo Plans: $Action mode ===")
[Console]::Error.WriteLine("Source: $SourceAccountId, Period: $From to $To")

# ---------- 1. Resolve target accounts ----------
$targetAccounts = @()

if ($TargetTeamId) {
    [Console]::Error.WriteLine("Resolving team $TargetTeamId members...")
    $members = Get-AllPages -Url "$BaseUrl/team-memberships/team/$TargetTeamId`?limit=1000"
    $targetAccounts = @($members | ForEach-Object { $_.member.accountId })
    [Console]::Error.WriteLine("  Found $($targetAccounts.Count) team members")
}

if ($TargetAccountIds) {
    $individualIds = @($TargetAccountIds -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $targetAccounts += $individualIds
    [Console]::Error.WriteLine("  Added $($individualIds.Count) individual accounts")
}

$targetAccounts = @($targetAccounts | Select-Object -Unique)

if ($targetAccounts.Count -eq 0) {
    throw "No target accounts specified. Provide either TargetTeamId or TargetAccountIds."
}

[Console]::Error.WriteLine("Targets: $($targetAccounts.Count) accounts")

# ---------- 2. Fetch source plans ----------
[Console]::Error.WriteLine("Fetching source plans...")
$sourcePlans = Get-AllPages -Url "$BaseUrl/plans/user/$SourceAccountId`?from=$From&to=$To&limit=1000"

if ($sourcePlans.Count -eq 0) {
    throw "No plans found for source account $SourceAccountId in period $From to $To"
}

# Filter by projects if specified
if ($ProjectIds) {
    $projectFilter = @($ProjectIds -split ',' | ForEach-Object { [int]$_.Trim() })
    $sourcePlans = @($sourcePlans | Where-Object { $projectFilter -contains $_.planItem.id })
    [Console]::Error.WriteLine("  Filtered to $($sourcePlans.Count) plans matching project IDs")
}

[Console]::Error.WriteLine("  Found $($sourcePlans.Count) source plan entries")

# Group by date for easier processing
$plansByDate = @{}
foreach ($plan in $sourcePlans) {
    $date = $plan.startDate
    if (-not $plansByDate.ContainsKey($date)) {
        $plansByDate[$date] = @()
    }
    $plansByDate[$date] += $plan
}

[Console]::Error.WriteLine("  Covering $($plansByDate.Count) unique dates")

# ---------- 3. Process each target ----------
$results = @()
$warnings = @()

foreach ($targetId in $targetAccounts) {
    [Console]::Error.WriteLine("Processing target: $targetId")

    # Fetch existing plans for target
    $existingPlans = Get-AllPages -Url "$BaseUrl/plans/user/$targetId`?from=$From&to=$To&limit=1000"

    # Group existing by date + project
    $existingByDateProject = @{}
    foreach ($plan in $existingPlans) {
        $key = "$($plan.startDate)|$($plan.planItem.id)"
        if (-not $existingByDateProject.ContainsKey($key)) {
            $existingByDateProject[$key] = @()
        }
        $existingByDateProject[$key] += $plan
    }

    # Fetch holidays if SkipHolidays enabled
    $holidays = @{}
    if ($SkipHolidays) {
        try {
            $holidayData = Get-AllPages -Url "$BaseUrl/holidays/user/$targetId`?from=$From&to=$To&limit=1000"
            foreach ($h in $holidayData) {
                $holidays[$h.date] = $true
            }
            if ($holidays.Count -gt 0) {
                [Console]::Error.WriteLine("  Found $($holidays.Count) holiday/vacation days")
            }
        } catch {
            [Console]::Error.WriteLine("  Warning: Could not fetch holidays - $($_.Exception.Message)")
        }
    }

    # Calculate what to copy
    $targetResult = @{
        accountId = $targetId
        entries = @()
        totalHours = 0
        skippedHolidays = 0
        conflicts = 0
        warnings = @()
    }

    foreach ($date in $plansByDate.Keys) {
        # Skip holidays
        if ($holidays.ContainsKey($date)) {
            $targetResult.skippedHolidays++
            continue
        }

        foreach ($sourcePlan in $plansByDate[$date]) {
            $projectId = $sourcePlan.planItem.id
            $projectName = $sourcePlan.planItem.name
            $sourceSeconds = $sourcePlan.plannedTime.plannedSeconds
            $sourceHours = [Math]::Round($sourceSeconds / 3600, 2)

            $key = "$date|$projectId"
            $existingForDateProject = $existingByDateProject[$key]

            $action = 'add'
            $newSeconds = $sourceSeconds
            $existingHours = 0

            if ($existingForDateProject) {
                $targetResult.conflicts++
                $existingHours = [Math]::Round(($existingForDateProject | Measure-Object -Property { $_.plannedTime.plannedSeconds } -Sum).Sum / 3600, 2)

                switch ($ConflictMode) {
                    'Keep' {
                        $action = 'skip'
                        $newSeconds = 0
                    }
                    'Replace' {
                        $action = 'replace'
                        $newSeconds = $sourceSeconds
                    }
                    'Add' {
                        $action = 'add'
                        $newSeconds = $sourceSeconds
                    }
                }
            }

            if ($action -ne 'skip') {
                $entry = @{
                    date = $date
                    projectId = $projectId
                    projectName = $projectName
                    hours = $sourceHours
                    action = $action
                    existingHours = $existingHours
                    newTotalHours = [Math]::Round(($existingHours * 3600 + $newSeconds) / 3600, 2)
                    plannedSeconds = $newSeconds
                }

                $targetResult.entries += $entry
                $targetResult.totalHours += $sourceHours
            }
        }
    }

    # Weekly validation
    $weeklyTotals = @{}
    foreach ($entry in $targetResult.entries) {
        $date = [datetime]::ParseExact($entry.date, 'yyyy-MM-dd', $null)
        $weekStart = $date.AddDays(-($date.DayOfWeek.value__ - 1)).ToString('yyyy-MM-dd')

        if (-not $weeklyTotals.ContainsKey($weekStart)) {
            $weeklyTotals[$weekStart] = 0
        }
        $weeklyTotals[$weekStart] += $entry.newTotalHours
    }

    foreach ($week in $weeklyTotals.Keys) {
        if ($weeklyTotals[$week] -gt $MaxWeeklyHours) {
            $warning = "Week ${week}: $($weeklyTotals[$week])h exceeds max $MaxWeeklyHours`h"
            $targetResult.warnings += $warning
            $warnings += "${targetId} - $warning"
        }
    }

    $results += $targetResult
}

# ---------- 4. Output results ----------
$summary = @{
    action = $Action
    source = @{
        accountId = $SourceAccountId
        from = $From
        to = $To
        planCount = $sourcePlans.Count
        dateCount = $plansByDate.Count
    }
    targets = $results
    totalHoursCopied = ($results | Measure-Object -Property totalHours -Sum).Sum
    totalEntries = ($results | Measure-Object -Property { $_.entries.Count } -Sum).Sum
    totalConflicts = ($results | Measure-Object -Property conflicts -Sum).Sum
    totalSkippedHolidays = ($results | Measure-Object -Property skippedHolidays -Sum).Sum
    warnings = $warnings
    conflictMode = $ConflictMode
}

Write-Output "=== BEGIN copy_plans_result.json ==="
$summary | ConvertTo-Json -Depth 10 | Write-Output
Write-Output "=== END copy_plans_result.json ==="

# ---------- 5. Execute write if requested ----------
if ($Action -eq 'Write') {
    [Console]::Error.WriteLine("Writing plans to Tempo API...")
    $written = 0

    foreach ($targetResult in $results) {
        $targetId = $targetResult.accountId

        foreach ($entry in $targetResult.entries) {
            if ($entry.action -eq 'replace') {
                # Delete existing first
                # Note: Tempo API requires fetching plan IDs first
                [Console]::Error.WriteLine("  Warning: Replace mode requires manual deletion of existing plans")
            }

            # Create new plan
            $planBody = @{
                assignee = @{ accountId = $targetId }
                planItem = @{ id = $entry.projectId }
                startDate = $entry.date
                endDate = $entry.date
                plannedSeconds = $entry.plannedSeconds
            }

            try {
                $created = Invoke-TempoApi -Method POST -Url "$BaseUrl/plans" -Body $planBody
                $written++
            }
            catch {
                $err = "Failed to write $($entry.date) for ${targetId}: $($_.Exception.Message)"
                $summary.warnings += $err
                [Console]::Error.WriteLine("  ERROR: $err")
            }
        }
    }

    [Console]::Error.WriteLine("Successfully wrote $written plan entries")
    $summary.writtenCount = $written

    # Re-output with write stats
    Write-Output "=== BEGIN copy_plans_result.json ==="
    $summary | ConvertTo-Json -Depth 10 | Write-Output
    Write-Output "=== END copy_plans_result.json ==="
}

[Console]::Error.WriteLine("Done.")
