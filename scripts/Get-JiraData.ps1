<#
.SYNOPSIS
    Fetches Jira changelog history and Tempo worklog summaries for burn-up tracking.

.DESCRIPTION
    Two operations via -Action parameter:
    - GetChangelogs: Fetches field change history using Jira's bulk changelog endpoint
    - GetWorklogSummary: Aggregates Tempo worklogs by ISO week and epic

.PARAMETER Action
    GetChangelogs or GetWorklogSummary

.PARAMETER JQL
    Jira query to find issues

.PARAMETER IssueKeys
    Array of specific issue keys (alternative to JQL)

.PARAMETER Fields
    Fields to track (for GetChangelogs). Comma-separated.

.PARAMETER Since
    Only changes on or after this date (yyyy-MM-dd)

.PARAMETER IncludeCurrent
    Include current field values (for GetChangelogs)

.PARAMETER From / To
    Date range for worklogs (yyyy-MM-dd)

.PARAMETER GroupBy
    Grouping dimensions for worklog summary. Comma-separated.

.PARAMETER TempoBaseUrl
    Tempo API base URL. Default https://api.tempo.io/4
    For EU region, use https://api.eu.tempo.io/4
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [ValidateSet('GetChangelogs', 'GetWorklogSummary')] [string] $Action,
    [string]   $JQL,
    [string[]] $IssueKeys = @(),
    [string]   $Fields = 'customfield_10008,status,resolution,fixVersions,parent',
    [string]   $Since,
    [string]   $IncludeCurrent = 'true',
    [string]   $From,
    [string]   $To,
    [string]   $GroupBy = 'week,epic',
    [string]   $TempoBaseUrl = 'https://api.eu.tempo.io/4'
)

$ErrorActionPreference = 'Stop'

# ---------- Configuration ----------
$jiraToken = $env:JIRA_API_TOKEN
$jiraEmail = $env:JIRA_EMAIL
$jiraBase = if ($env:JIRA_BASE_URL) { $env:JIRA_BASE_URL } else { 'https://starwiki.atlassian.net' }
$tempoToken = $env:TEMPO_API_TOKEN

if ([string]::IsNullOrWhiteSpace($jiraToken) -or [string]::IsNullOrWhiteSpace($jiraEmail)) {
    throw "JIRA_API_TOKEN and JIRA_EMAIL environment variables must be set"
}

$jiraHeaders = @{
    Authorization = "Basic " + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${jiraEmail}:${jiraToken}"))
    Accept = 'application/json'
}

$tempoHeaders = @{
    Authorization = "Bearer $tempoToken"
    Accept = 'application/json'
}

# ---------- HTTP helper with retry ----------
function Invoke-ApiCall {
    param(
        [string] $Method,
        [string] $Url,
        [hashtable] $Headers,
        $Body = $null
    )
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            $params = @{
                Method = $Method
                Uri = $Url
                Headers = $Headers
                UseBasicParsing = $true
            }
            if ($null -ne $Body) {
                $json = $Body | ConvertTo-Json -Depth 10 -Compress
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

            # Handle rate limiting
            if ($status -eq 429 -and $attempt -le 3) {
                $retryAfter = 5
                if ($_.Exception.Response.Headers['Retry-After']) {
                    $retryAfter = [int]$_.Exception.Response.Headers['Retry-After']
                }
                Write-Host "Rate limited (429) - retrying in $retryAfter seconds..."
                Start-Sleep -Seconds $retryAfter
                continue
            }

            # Return detailed error message
            $errorMsg = "HTTP $status for $Url"
            try {
                $errorBody = $_.ErrorDetails.Message | ConvertFrom-Json
                if ($errorBody.errorMessages) {
                    $errorMsg += ": " + ($errorBody.errorMessages -join '; ')
                } elseif ($errorBody.errors) {
                    $errorMsg += ": " + ($errorBody.errors | ConvertTo-Json -Compress)
                }
            } catch {
                $errorMsg += ": " + $_.Exception.Message
            }
            throw $errorMsg
        }
    }
}

# ---------- Resolve JQL to issue IDs ----------
function Get-IssuesFromJQL {
    param([string] $JQL)

    Write-Host "Resolving JQL to issue IDs..."
    $allIssues = @()
    $nextPageToken = $null

    do {
        $body = @{
            jql = $JQL
            fields = @('id', 'key')
            maxResults = 1000
        }
        if ($nextPageToken) {
            $body.nextPageToken = $nextPageToken
        }

        $result = Invoke-ApiCall -Method POST -Url "$jiraBase/rest/api/3/search/jql" -Headers $jiraHeaders -Body $body
        $allIssues += $result.issues
        $nextPageToken = $result.nextPageToken
    } while ($nextPageToken)

    Write-Host "Found $($allIssues.Count) issues"
    return $allIssues
}

# ---------- GetChangelogs Action ----------
if ($Action -eq 'GetChangelogs') {
    # Resolve issues
    $issues = if ($JQL) {
        Get-IssuesFromJQL -JQL $JQL
    } else {
        $IssueKeys | ForEach-Object {
            @{ id = $_; key = $_ }
        }
    }

    if ($issues.Count -eq 0) {
        throw "No issues found"
    }

    # Parse fields and map to changelog field names
    $fieldList = $Fields -split ','

    # Map field IDs/names to changelog field names
    $fieldMapping = @{
        'customfield_10008' = 'Story Points'
        'status' = 'status'
        'resolution' = 'resolution'
        'fixVersions' = 'Fix Version'
        'parent' = 'IssueParentAssociation'
    }

    # Build list of changelog field names to match
    $changelogFields = @()
    foreach ($field in $fieldList) {
        $field = $field.Trim()
        if ($fieldMapping.ContainsKey($field)) {
            $changelogFields += $fieldMapping[$field]
        } else {
            # Use as-is if not in mapping
            $changelogFields += $field
        }
    }

    Write-Host "Tracking changelog fields: $($changelogFields -join ', ')"

    # Fetch changelogs in batches (max 1000 per call)
    Write-Host "Fetching changelogs for $($issues.Count) issues..."
    $allChanges = @()
    $batchSize = 1000

    for ($i = 0; $i -lt $issues.Count; $i += $batchSize) {
        $batch = $issues[$i..[Math]::Min($i + $batchSize - 1, $issues.Count - 1)]
        $issueIds = $batch | ForEach-Object { $_.id }

        $nextPageToken = $null
        do {
            $body = @{
                issueIdsOrKeys = @($issueIds)
            }
            if ($nextPageToken) {
                $body.nextPageToken = $nextPageToken
            }

            $result = Invoke-ApiCall -Method POST -Url "$jiraBase/rest/api/3/changelog/bulkfetch" -Headers $jiraHeaders -Body $body

            Write-Host "  Received $($result.issueChangeLogs.Count) issue changelogs in this batch"

            # Structure: issueChangeLogs[] → changeHistories[] → items[]
            foreach ($issueLog in $result.issueChangeLogs) {
                foreach ($history in $issueLog.changeHistories) {
                    foreach ($change in $history.items) {
                        # Filter by field - match against changelog field names OR fieldId
                        if ($changelogFields -contains $change.field -or $changelogFields -contains $change.fieldId) {
                            $changeDate = [datetime]::Parse($history.created)

                            # Filter by since date
                            if ($Since) {
                                $sinceDate = [datetime]::ParseExact($Since, 'yyyy-MM-dd', $null)
                                if ($changeDate -lt $sinceDate) { continue }
                            }

                            $allChanges += [PSCustomObject]@{
                                issueKey = $issueLog.issueKey
                                changedAt = $changeDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                                field = $change.field
                                from = $change.fromString
                                to = $change.toString
                            }
                        }
                    }
                }
            }

            $nextPageToken = $result.nextPageToken
        } while ($nextPageToken)
    }

    Write-Host "Found $($allChanges.Count) changes after filtering"

    # Debug: show sample of what fields we saw
    if ($allChanges.Count -gt 0) {
        Write-Host "  Sample changes: $($allChanges[0..([Math]::Min(2, $allChanges.Count - 1))] | ForEach-Object { "$($_.issueKey):$($_.field)" } | Select-Object -First 3)"
    }

    # Fetch current values if requested
    $currentValues = @()
    if ($IncludeCurrent -eq 'true') {
        Write-Host "Fetching current values..."
        $fieldSpec = @('key', 'issuetype', 'status', 'resolution', 'resolutiondate', 'created', 'customfield_10008', 'fixVersions', 'parent')

        $nextPageToken = $null
        do {
            $body = @{
                jql = "key in ($($issues.key -join ','))"
                fields = $fieldSpec
                maxResults = 1000
            }
            if ($nextPageToken) {
                $body.nextPageToken = $nextPageToken
            }

            $result = Invoke-ApiCall -Method POST -Url "$jiraBase/rest/api/3/search/jql" -Headers $jiraHeaders -Body $body

            foreach ($issue in $result.issues) {
                $currentValues += [PSCustomObject]@{
                    issueKey = $issue.key
                    issueType = $issue.fields.issuetype.name
                    created = $issue.fields.created
                    status = $issue.fields.status.name
                    statusCategory = $issue.fields.status.statusCategory.name
                    resolution = $issue.fields.resolution.name
                    resolutionDate = $issue.fields.resolutiondate
                    storyPoints = $issue.fields.customfield_10008
                    fixVersions = ($issue.fields.fixVersions | ForEach-Object { $_.name }) -join ';'
                    parentKey = $issue.fields.parent.key
                }
            }

            $nextPageToken = $result.nextPageToken
        } while ($nextPageToken)
    }

    # Output CSV sections
    Write-Output "=== BEGIN changes.csv ==="
    $allChanges | ConvertTo-Csv -NoTypeInformation | Write-Output
    Write-Output "=== END changes.csv ==="

    if ($currentValues.Count -gt 0) {
        Write-Output "=== BEGIN current.csv ==="
        $currentValues | ConvertTo-Csv -NoTypeInformation | Write-Output
        Write-Output "=== END current.csv ==="
    }
}

# ---------- GetWorklogSummary Action ----------
if ($Action -eq 'GetWorklogSummary') {
    if (-not $tempoToken) {
        throw "TEMPO_API_TOKEN environment variable must be set"
    }

    # Resolve issues and map to epics in batch
    Write-Host "Resolving issues and epics..."
    $issueToEpic = @{}
    $issueIds = @()

    $nextPageToken = $null
    do {
        $body = @{
            jql = $JQL
            fields = @('id', 'key', 'parent')
            maxResults = 1000
        }
        if ($nextPageToken) {
            $body.nextPageToken = $nextPageToken
        }

        $result = Invoke-ApiCall -Method POST -Url "$jiraBase/rest/api/3/search/jql" -Headers $jiraHeaders -Body $body

        foreach ($issue in $result.issues) {
            # Convert id to integer for Tempo API
            $issueId = [int]$issue.id
            $issueIds += $issueId

            # Get epic key from parent
            $epicKey = if ($issue.fields.parent) {
                $issue.fields.parent.key
            } else {
                $issue.key  # Issue is its own epic
            }
            $issueToEpic[$issueId] = $epicKey
        }

        $nextPageToken = $result.nextPageToken
    } while ($nextPageToken)

    Write-Host "Found $($issueIds.Count) issues with their epics"

    # Fetch worklogs in batches
    Write-Host "Fetching worklogs from Tempo..."
    $allWorklogs = @()
    $batchSize = 1000

    for ($i = 0; $i -lt $issueIds.Count; $i += $batchSize) {
        $batch = $issueIds[$i..[Math]::Min($i + $batchSize - 1, $issueIds.Count - 1)]

        $offset = 0
        $limit = 5000
        do {
            $body = @{
                from = $From
                to = $To
                issueIds = @($batch)
                offset = $offset
                limit = $limit
            }

            $result = Invoke-ApiCall -Method POST -Url "$TempoBaseUrl/worklogs/search" -Headers $tempoHeaders -Body $body
            $allWorklogs += $result.results

            $offset += $limit
        } while ($result.results.Count -eq $limit)
    }

    Write-Host "Processing $($allWorklogs.Count) worklogs..."

    # Group by dimensions
    $groupDimensions = $GroupBy -split ','
    $grouped = @{}

    foreach ($worklog in $allWorklogs) {
        $worklogDate = [datetime]::Parse($worklog.startDate)

        # Calculate ISO week
        $culture = [System.Globalization.CultureInfo]::InvariantCulture
        $calendar = $culture.Calendar
        $isoYear = $worklogDate.Year
        $isoWeek = $calendar.GetWeekOfYear($worklogDate, [System.Globalization.CalendarWeekRule]::FirstFourDayWeek, [DayOfWeek]::Monday)

        # Get Monday of the week
        $daysToMonday = ($worklogDate.DayOfWeek.value__ - 1)
        if ($daysToMonday -lt 0) { $daysToMonday += 7 }
        $weekStart = $worklogDate.AddDays(-$daysToMonday).ToString('yyyy-MM-dd')

        # Build group key
        $keyParts = @()
        foreach ($dim in $groupDimensions) {
            switch ($dim) {
                'week' { $keyParts += "$isoYear-W$($isoWeek.ToString('00'))" }
                'epic' { $keyParts += $issueToEpic[$worklog.issue.id] }
                'issue' { $keyParts += $worklog.issue.key }
                'author' { $keyParts += $worklog.author.accountId }
            }
        }
        $groupKey = $keyParts -join '|'

        if (-not $grouped.ContainsKey($groupKey)) {
            $grouped[$groupKey] = @{
                isoYear = $isoYear
                isoWeek = $isoWeek
                weekStart = $weekStart
                epicKey = $issueToEpic[$worklog.issue.id]
                issueKey = $worklog.issue.key
                author = $worklog.author.accountId
                hours = 0
                worklogCount = 0
            }
        }

        $grouped[$groupKey].hours += [Math]::Round($worklog.timeSpentSeconds / 3600, 2)
        $grouped[$groupKey].worklogCount += 1
    }

    # Output summary
    $summary = $grouped.Values | Sort-Object isoYear, isoWeek, epicKey

    Write-Output "=== BEGIN worklog_summary.csv ==="

    # Build CSV columns based on grouping
    $headers = @()
    if ($groupDimensions -contains 'week') {
        $headers += @('isoYear', 'isoWeek', 'weekStart')
    }
    if ($groupDimensions -contains 'epic') {
        $headers += 'epicKey'
    }
    if ($groupDimensions -contains 'issue') {
        $headers += 'issueKey'
    }
    if ($groupDimensions -contains 'author') {
        $headers += 'author'
    }
    $headers += @('hours', 'worklogCount')

    $summary | Select-Object -Property $headers | ConvertTo-Csv -NoTypeInformation | Write-Output

    # Control sum - handle empty results
    if ($summary) {
        $totalHours = ($summary | Measure-Object -Property hours -Sum).Sum
        $totalCount = ($summary | Measure-Object -Property worklogCount -Sum).Sum
    } else {
        $totalHours = 0
        $totalCount = 0
    }
    Write-Output "TOTAL,$totalHours,$totalCount"

    Write-Output "=== END worklog_summary.csv ==="
}

Write-Host "Done."
