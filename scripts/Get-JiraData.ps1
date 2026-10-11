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
                [Console]::Error.WriteLine("[api-debug] Rate limited (429) - retrying in $retryAfter seconds...")
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

    [Console]::Error.WriteLine("[jira-debug] Resolving JQL to issue IDs...")
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

    [Console]::Error.WriteLine("[jira-debug] Found $($allIssues.Count) issues")
    return $allIssues
}

# ---------- GetChangelogs Action ----------
if ($Action -eq 'GetChangelogs') {
    # Debug logging to file
    $dbgFile = Join-Path $PSScriptRoot "changelog-debug.log"
    function Dbg($m) { Add-Content $dbgFile "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" }

    Dbg "=== START GetChangelogs ==="
    Dbg "JQL: $JQL"
    Dbg "IssueKeys: $($IssueKeys -join ',')"
    Dbg "Fields: $Fields"
    Dbg "Since: $Since"
    Dbg "IncludeCurrent: $IncludeCurrent"

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

    Dbg "Resolved $($issues.Count) issues: $($issues | ForEach-Object { $_.key } | Select-Object -First 5 | Join-String -Separator ',')"
    [Console]::Error.WriteLine("[changelog-debug] Processing $($issues.Count) issues")

    # Parse fields and map to changelog field names
    $fieldList = $Fields -split ','
    Dbg "Parsed field list: $($fieldList -join ', ')"

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

    Dbg "Tracking changelog fields: $($changelogFields -join ', ')"
    [Console]::Error.WriteLine("[changelog-debug] Tracking fields: $($changelogFields -join ', ')")

    # Fetch changelogs in batches (max 1000 per call)
    [Console]::Error.WriteLine("[changelog-debug] Fetching changelogs for $($issues.Count) issues...")
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

            # Debug: log API response structure
            $responseKeys = ($result | Get-Member -MemberType NoteProperty).Name -join ', '
            Dbg "API response keys: $responseKeys"
            Dbg "issueChangeLogs count: $($result.issueChangeLogs.Count)"

            if ($result.issueChangeLogs.Count -gt 0) {
                $firstIssue = $result.issueChangeLogs[0]
                Dbg "First issue: $($firstIssue.issueKey), changeHistories: $($firstIssue.changeHistories.Count)"
                if ($firstIssue.changeHistories.Count -gt 0) {
                    $firstHistory = $firstIssue.changeHistories[0]
                    Dbg "First history created: $($firstHistory.created), items: $($firstHistory.items.Count)"
                    if ($firstHistory.items.Count -gt 0) {
                        $firstItem = $firstHistory.items[0]
                        Dbg "First item: field='$($firstItem.field)', fieldId='$($firstItem.fieldId)', from='$($firstItem.fromString)', to='$($firstItem.toString)'"
                    }
                }
            }

            [Console]::Error.WriteLine("[changelog-debug] Received $($result.issueChangeLogs.Count) issue changelogs")

            # Structure: issueChangeLogs[] → changeHistories[] → items[]
            foreach ($issueLog in $result.issueChangeLogs) {
                $totalHistories = $issueLog.changeHistories.Count
                [Console]::Error.WriteLine("[changelog-debug] Issue $($issueLog.issueKey): $totalHistories change histories")

                foreach ($history in $issueLog.changeHistories) {
                    foreach ($change in $history.items) {
                        # Filter by field - match against changelog field names OR fieldId
                        if ($changelogFields -contains $change.field -or $changelogFields -contains $change.fieldId) {
                            # Convert Unix timestamp (milliseconds) to DateTime
                            $changeDate = [DateTimeOffset]::FromUnixTimeMilliseconds($history.created).DateTime

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

    Dbg "Total changes after filtering: $($allChanges.Count)"
    if ($allChanges.Count -gt 0) {
        $sample = $allChanges[0..([Math]::Min(2, $allChanges.Count - 1))] | ForEach-Object { "$($_.issueKey):$($_.field):$($_.from)→$($_.to)" }
        Dbg "Sample changes: $($sample -join ', ')"
    }

    [Console]::Error.WriteLine("[changelog-debug] Found $($allChanges.Count) changes after filtering")
    if ($allChanges.Count -gt 0) {
        $sample = $allChanges[0..([Math]::Min(2, $allChanges.Count - 1))] | ForEach-Object { "$($_.issueKey):$($_.field):$($_.from)→$($_.to)" }
        [Console]::Error.WriteLine("[changelog-debug] Sample: $($sample -join ', ')")
    }

    # Fetch current values if requested
    $currentValues = @()
    if ($IncludeCurrent -eq 'true') {
        Dbg "Fetching current values..."
        [Console]::Error.WriteLine("[changelog-debug] Fetching current values...")
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
    Dbg "Writing output: changes=$($allChanges.Count) rows, current=$($currentValues.Count) rows"

    Write-Output "=== BEGIN changes.csv ==="
    $allChanges | ConvertTo-Csv -NoTypeInformation | Write-Output
    Write-Output "=== END changes.csv ==="

    if ($currentValues.Count -gt 0) {
        Write-Output "=== BEGIN current.csv ==="
        $currentValues | ConvertTo-Csv -NoTypeInformation | Write-Output
        Write-Output "=== END current.csv ==="
    }

    Dbg "=== END GetChangelogs ==="
}

# ---------- GetWorklogSummary Action ----------
if ($Action -eq 'GetWorklogSummary') {
    if (-not $tempoToken) {
        throw "TEMPO_API_TOKEN environment variable must be set"
    }

    # Resolve issues and map to epics in batch
    [Console]::Error.WriteLine("[worklog-debug] Resolving issues and epics...")
    $issueToEpic = @{}
    $issueIdToKey = @{}
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

            # Map issue ID to key (Tempo worklogs only have ID, not key)
            $issueIdToKey[$issueId] = $issue.key

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

    [Console]::Error.WriteLine("[worklog-debug] Found $($issueIds.Count) issues with their epics")

    # Fetch worklogs in batches
    [Console]::Error.WriteLine("[worklog-debug] Fetching worklogs from Tempo...")
    $allWorklogs = @()
    $batchSize = 1000

    for ($i = 0; $i -lt $issueIds.Count; $i += $batchSize) {
        $batch = $issueIds[$i..[Math]::Min($i + $batchSize - 1, $issueIds.Count - 1)]

        # Use metadata.next pagination pattern
        $url = "$TempoBaseUrl/worklogs/search?limit=5000"
        $body = @{
            from = $From
            to = $To
            issueIds = @($batch)
        }

        do {
            $result = Invoke-ApiCall -Method POST -Url $url -Headers $tempoHeaders -Body $body
            $allWorklogs += $result.results

            # Get next page URL from metadata
            $url = $result.metadata.next
        } while ($url)
    }

    [Console]::Error.WriteLine("[worklog-debug] Processing $($allWorklogs.Count) worklogs...")

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
        # Convert worklog issue ID to int to match hashtable key types
        $worklogIssueId = [int]$worklog.issue.id
        # Tempo worklogs only have issue.id, not issue.key - lookup from mapping
        $worklogIssueKey = $issueIdToKey[$worklogIssueId]

        foreach ($dim in $groupDimensions) {
            switch ($dim) {
                'week' { $keyParts += "$isoYear-W$($isoWeek.ToString('00'))" }
                'epic' { $keyParts += $issueToEpic[$worklogIssueId] }
                'issue' { $keyParts += $worklogIssueKey }
                'author' { $keyParts += $worklog.author.accountId }
            }
        }
        $groupKey = $keyParts -join '|'

        if (-not $grouped.ContainsKey($groupKey)) {
            $grouped[$groupKey] = [PSCustomObject]@{
                isoYear = $isoYear
                isoWeek = $isoWeek
                weekStart = $weekStart
                epicKey = $issueToEpic[$worklogIssueId]
                issueKey = $worklogIssueKey
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

[Console]::Error.WriteLine("[script-debug] Done.")
