<#
.SYNOPSIS
    Exports Tempo Planner plans and/or Tempo worklogs for selected teams and
    people within a date range, and saves them as CSV files.

.DESCRIPTION
    Read-only: the script only uses search/list (read) endpoints.
    The Tempo API token is read from the TEMPO_API_TOKEN environment variable,
    so it never needs to be written into the script or typed on the command line.

    Recommended token scopes (Tempo > Settings > API Integration > Custom access):
      - Plans: View        (for plans)
      - Worklogs: View     (for worklogs)
      - Teams: View        (to resolve team members)

.PARAMETER From
    Start date, yyyy-MM-dd (inclusive).

.PARAMETER To
    End date, yyyy-MM-dd (inclusive).

.PARAMETER TeamIds
    One or more Tempo team IDs. Members whose membership overlaps the
    time frame are included.

.PARAMETER AccountIds
    One or more Atlassian account IDs for individual people.

.PARAMETER Data
    Plans, Worklogs or Both (default: Both).

.PARAMETER OutDir
    Folder for the CSV files (default: current folder).

.PARAMETER BaseUrl
    Tempo API base URL. Default https://api.eu.tempo.io/4
    For US region, use https://api.tempo.io/4

.EXAMPLE
    $env:TEMPO_API_TOKEN = Read-Host "Tempo token" -AsSecureString |
        ForEach-Object { [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($_)) }

    .\Get-TempoData.ps1 -From 2026-10-01 -To 2026-10-31 -TeamIds 12,15 `
        -AccountIds "712020:abc..." -Data Both -OutDir .\export
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]   $From,
    [Parameter(Mandatory)] [string]   $To,
    [string]   $TeamIds    = '',
    [string]   $AccountIds = '',
    [ValidateSet('Plans', 'Worklogs', 'Both')] [string] $Data = 'Both',
    [string]   $OutDir  = '.',
    [string]   $BaseUrl = 'https://api.eu.tempo.io/4',
    [int]      $PageSize = 1000,
    [switch]   $PassThru
)

$ErrorActionPreference = 'Stop'

# ---------- Parse parameters ----------
# TeamIds and AccountIds come as comma-separated strings from MCP server
$TeamIdList = if ($TeamIds) { $TeamIds -split ',' | ForEach-Object { [int]$_.Trim() } } else { @() }
$AccountIdList = if ($AccountIds) { $AccountIds -split ',' | ForEach-Object { $_.Trim() } } else { @() }

# ---------- Validation ----------
$token = $env:TEMPO_API_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
    throw "Set the TEMPO_API_TOKEN environment variable first (see the example in the help: Get-Help .\Get-TempoData.ps1 -Examples)."
}
foreach ($d in @($From, $To)) {
    [void][datetime]::ParseExact($d, 'yyyy-MM-dd', $null)
}
if ($TeamIdList.Count -eq 0 -and $AccountIdList.Count -eq 0) {
    throw "Specify at least one -TeamIds or -AccountIds."
}
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$headers = @{ Authorization = "Bearer $token"; Accept = 'application/json' }

# ---------- HTTP helper (UTF-8 safe, retries on 429/5xx) ----------
function Invoke-Tempo {
    param(
        [string] $Method,
        [string] $Url,
        $Body = $null
    )
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            $params = @{
                Method          = $Method
                Uri             = $Url
                Headers         = $headers
                UseBasicParsing = $true
            }
            if ($null -ne $Body) {
                $json = $Body | ConvertTo-Json -Depth 10 -Compress
                $params.Body        = [Text.Encoding]::UTF8.GetBytes($json)
                $params.ContentType = 'application/json; charset=utf-8'
            }
            $resp = Invoke-WebRequest @params
            $text = [Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
            Start-Sleep -Milliseconds 250   # be gentle with the API
            return ($text | ConvertFrom-Json)
        }
        catch {
            $status = $null
            if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
            if (($status -eq 429 -or $status -ge 500) -and $attempt -le 5) {
                $wait = [math]::Pow(2, $attempt)
                Write-Warning "HTTP $status from Tempo - retrying in $wait s..."
                Start-Sleep -Seconds $wait
                continue
            }
            if ($status -eq 401) { throw "401 Unauthorized - check that the token is valid and that BaseUrl is right for your region." }
            if ($status -eq 403) { throw "403 Forbidden - the token lacks a scope, or your Tempo permissions do not allow this data. URL: $Url" }
            throw
        }
    }
}

# Follows metadata.next until all pages are fetched.
function Get-AllPages {
    param([string] $Method, [string] $Url, $Body = $null)
    $all  = New-Object System.Collections.Generic.List[object]
    $next = $Url
    while ($next) {
        $page = Invoke-Tempo -Method $Method -Url $next -Body $Body
        if ($page.results) { foreach ($r in $page.results) { $all.Add($r) } }
        $next = $null
        if ($page.metadata -and $page.metadata.next) { $next = $page.metadata.next }
    }
    return $all
}

# ---------- Flatten nested JSON into CSV-friendly columns ----------
function ConvertTo-Flat {
    param($Obj, [string] $Prefix = '', $Into = $null)
    if ($null -eq $Into) { $Into = [ordered]@{} }
    foreach ($p in $Obj.PSObject.Properties) {
        $name = if ($Prefix) { "$Prefix.$($p.Name)" } else { $p.Name }
        $v = $p.Value
        if ($null -eq $v) { $Into[$name] = $null }
        elseif ($v -is [System.Management.Automation.PSCustomObject]) {
            if ($p.Name -eq 'self') { continue }
            [void](ConvertTo-Flat -Obj $v -Prefix $name -Into $Into)
        }
        elseif ($v -is [array]) {
            if ($v.Count -gt 0 -and $v[0] -is [System.Management.Automation.PSCustomObject]) {
                $Into[$name] = ($v | ConvertTo-Json -Depth 10 -Compress)
            } else {
                $Into[$name] = ($v -join ';')
            }
        }
        elseif ($p.Name -ne 'self') { $Into[$name] = $v }
    }
    return $Into
}

# ---------- Resolve teams to people ----------
$teamOf = @{}   # accountId -> list of team names/ids

function Add-TeamTag([string] $accountId, [string] $tag) {
    if (-not $teamOf.ContainsKey($accountId)) { $teamOf[$accountId] = New-Object System.Collections.Generic.List[string] }
    if (-not $teamOf[$accountId].Contains($tag)) { $teamOf[$accountId].Add($tag) }
}

$people = New-Object System.Collections.Generic.HashSet[string]
foreach ($a in $AccountIdList) { [void]$people.Add($a); Add-TeamTag $a '(individual)' }

$rangeStart = [datetime]::ParseExact($From, 'yyyy-MM-dd', $null)
$rangeEnd   = [datetime]::ParseExact($To,   'yyyy-MM-dd', $null)

foreach ($teamId in $TeamIdList) {
    $teamName = "team $teamId"
    try {
        $team = Invoke-Tempo -Method GET -Url "$BaseUrl/teams/$teamId"
        if ($team.name) { $teamName = $team.name }
    } catch { Write-Warning "Could not read name of team $teamId : $($_.Exception.Message)" }

    [Console]::Error.WriteLine "Resolving members of '$teamName'..."
    $members = Get-AllPages -Method GET -Url "$BaseUrl/team-memberships/team/$teamId`?limit=$PageSize"

    foreach ($m in $members) {
        $acc = $m.member.accountId
        if (-not $acc) { continue }   # skips generic resources
        # Keep only memberships that overlap the requested time frame
        $mFrom = if ($m.from) { [datetime]$m.from } else { [datetime]::MinValue }
        $mTo   = if ($m.to)   { [datetime]$m.to }   else { [datetime]::MaxValue }
        if ($mFrom -le $rangeEnd -and $mTo -ge $rangeStart) {
            [void]$people.Add($acc)
            Add-TeamTag $acc $teamName
        }
    }
}

if ($people.Count -eq 0) { throw "No people found for the given teams/accounts in that time frame." }
$peopleList = @($people)
[Console]::Error.WriteLine "Fetching data for $($peopleList.Count) people, $From to $To."

function Export-Rows($rows, [string] $accountField, [string] $file, [hashtable] $hoursFrom) {
    $flat = foreach ($r in $rows) {
        $f = ConvertTo-Flat -Obj $r
        $acc = $f[$accountField]
        $f['Teams'] = if ($acc -and $teamOf.ContainsKey($acc)) { ($teamOf[$acc] -join '; ') } else { '' }
        foreach ($k in $hoursFrom.Keys) {
            if ($f.Contains($hoursFrom[$k]) -and $null -ne $f[$hoursFrom[$k]]) {
                $f[$k] = [math]::Round([double]$f[$hoursFrom[$k]] / 3600, 2)
            }
        }
        [pscustomobject]$f
    }
    if (-not $flat) { [Console]::Error.WriteLine "  No rows - nothing to export for $file"; return }

    # Union of all columns, so rows with extra fields don't lose data
    $cols = New-Object System.Collections.Generic.List[string]
    foreach ($row in $flat) { foreach ($n in $row.PSObject.Properties.Name) { if (-not $cols.Contains($n)) { $cols.Add($n) } } }

    if ($PassThru) {
        # Output to stdout for MCP server consumption
        [Console]::Error.WriteLine "  Returning $(@($flat).Count) rows"
        Write-Output "=== BEGIN $file ==="
        $flat | Select-Object -Property $cols | ConvertTo-Csv -NoTypeInformation | Write-Output
        Write-Output "=== END $file ==="
    } else {
        # Write to file
        $path = Join-Path $OutDir $file
        $flat | Select-Object -Property $cols | Export-Csv -Path $path -NoTypeInformation -Encoding UTF8
        [Console]::Error.WriteLine "  Wrote $(@($flat).Count) rows to $path"
    }
}

# Helper to fetch data per user
function Get-TempoDataForUsers {
    param(
        [string] $DataType,
        [string] $Endpoint,
        [string] $AccountField,
        [hashtable] $HoursMapping
    )

    [Console]::Error.WriteLine "Fetching $DataType..."
    $results = New-Object System.Collections.Generic.List[object]

    foreach ($acc in $peopleList) {
        $url = "$BaseUrl/$Endpoint/user/$acc`?from=$From&to=$To&limit=$PageSize"
        foreach ($item in (Get-AllPages -Method GET -Url $url)) {
            $results.Add($item)
        }
    }

    $stamp = "$From`_$To"
    $fileName = "tempo-$($DataType.ToLower())_$stamp.csv"
    Export-Rows $results $AccountField $fileName $HoursMapping
}

# ---------- Plans ----------
if ($Data -in 'Plans', 'Both') {
    Get-TempoDataForUsers -DataType 'plans' -Endpoint 'plans' -AccountField 'assignee.id' -HoursMapping @{
        'PlannedHoursPerDay' = 'plannedSecondsPerDay'
        'TotalPlannedHours'  = 'totalPlannedSecondsInScope'
    }
}

# ---------- Worklogs ----------
if ($Data -in 'Worklogs', 'Both') {
    Get-TempoDataForUsers -DataType 'worklogs' -Endpoint 'worklogs' -AccountField 'author.accountId' -HoursMapping @{
        'Hours'         = 'timeSpentSeconds'
        'BillableHours' = 'billableSeconds'
    }
}

[Console]::Error.WriteLine "Done."
