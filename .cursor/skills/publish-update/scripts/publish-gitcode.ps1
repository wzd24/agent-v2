param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$NotesFile
)

$ErrorActionPreference = "Stop"
$Api = "https://api.gitcode.com/api/v5/repos/wzd24/agent"
$token = [Environment]::GetEnvironmentVariable("GITCODE_TOKEN")
if ([string]::IsNullOrWhiteSpace($token)) {
  Write-Error "GITCODE_TOKEN is not set."
  exit 2
}

$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$uploadName = "Scorpio-Agent_${Version}_x64-setup.exe"
$publicInstaller = "https://gitcode.com/wzd24/agent/releases/download/v$Version/$uploadName"
$publicFeed = "https://gitcode.com/wzd24/agent/releases/download/feed/latest.json"
$work = Join-Path $env:TEMP "scorpio-publish-$Version"
New-Item -ItemType Directory -Force -Path $work | Out-Null

function Read-JsonFile([string]$Path) {
  $text = [System.IO.File]::ReadAllText($Path, [System.Text.UTF8Encoding]::new($false))
  return $text | ConvertFrom-Json
}

function Write-NodeScript([string]$Path, [string]$Source) {
  [System.IO.File]::WriteAllText($Path, $Source, [System.Text.UTF8Encoding]::new($false))
}

function Invoke-Curl {
  param([string[]]$CurlArgs)
  $out = Join-Path $work ("curl-" + [guid]::NewGuid().ToString("n") + ".out")
  $code = & curl.exe -o $out -w "%{http_code}" @CurlArgs
  if ($LASTEXITCODE -ne 0) {
    throw "curl failed with exit $LASTEXITCODE"
  }
  return @{ Code = "$code".Trim(); Path = $out }
}

function Invoke-Api {
  param([string]$Method, [string]$Url, [string]$BodyFile)
  $curlArgs = @("-sS", "-X", $Method, "-H", "PRIVATE-TOKEN: $token", "-H", "Accept: application/json")
  if ($BodyFile) {
    $curlArgs += @("-H", "Content-Type: application/json", "--data-binary", "@$($BodyFile -replace '\\','/')")
  }
  $curlArgs += $Url
  return Invoke-Curl $curlArgs
}

function Find-NamedId($node, [string]$name) {
  if ($null -eq $node) { return $null }
  if ($node -is [System.Array]) {
    foreach ($item in $node) {
      $found = Find-NamedId $item $name
      if ($found) { return $found }
    }
    return $null
  }
  if ($node -is [System.Management.Automation.PSCustomObject]) {
    $nodeName = $node.PSObject.Properties["name"]
    $nodeId = $node.PSObject.Properties["id"]
    if ($nodeName -and $nodeId -and [string]$nodeName.Value -eq $name -and $nodeId.Value) {
      return [string]$nodeId.Value
    }
    foreach ($prop in $node.PSObject.Properties) {
      $found = Find-NamedId $prop.Value $name
      if ($found) { return $found }
    }
  }
  return $null
}

function Send-Upload {
  param([string]$Tag, [string]$FileName, [string]$FilePath)
  $encodedTag = [uri]::EscapeDataString($Tag)
  $encodedName = [uri]::EscapeDataString($FileName)
  $meta = Invoke-Api "GET" "$Api/releases/$encodedTag/upload_url?file_name=$encodedName"
  if ($meta.Code -notmatch "^2") {
    throw "upload_url for $FileName returned HTTP $($meta.Code)"
  }
  $payload = Read-JsonFile $meta.Path
  $headers = $payload.headers
  $url = [string]$payload.url
  if ([string]::IsNullOrWhiteSpace($url)) {
    throw "upload_url for $FileName did not include a url"
  }
  $fileArg = "@$($FilePath -replace '\\','/')"
  $result = Invoke-Curl @(
    "-sS", "-X", "PUT",
    "-H", "x-obs-meta-project-id: $($headers.'x-obs-meta-project-id')",
    "-H", "x-obs-acl: $($headers.'x-obs-acl')",
    "-H", "x-obs-callback: $($headers.'x-obs-callback')",
    "-H", "Content-Type: $($headers.'Content-Type')",
    "--data-binary", $fileArg,
    $url
  )
  Remove-Item -LiteralPath $meta.Path -Force -ErrorAction SilentlyContinue
  if ($result.Code -ne "200") {
    throw "upload $FileName returned HTTP $($result.Code)"
  }
  Remove-Item -LiteralPath $result.Path -Force -ErrorAction SilentlyContinue
}

try {
  if (-not (Test-Path -LiteralPath $installer)) { throw "Installer not found." }
  $notes = [string](Read-JsonFile (Resolve-Path -LiteralPath $NotesFile).Path).notes
  if ([string]::IsNullOrWhiteSpace($notes)) { throw "Notes file has an empty notes field." }

  $jsonWriter = Join-Path $work "write-json.js"
  Write-NodeScript $jsonWriter @'
const fs = require("fs");
const kind = process.argv[2];
const notes = JSON.parse(fs.readFileSync(process.argv[3], "utf8")).notes;
if (kind === "release") {
  fs.writeFileSync(process.argv[4], JSON.stringify({
    tag_name: process.argv[5],
    name: process.argv[5],
    body: notes,
    target_commitish: "main",
    release_status: "latest"
  }));
} else if (kind === "feed-release") {
  fs.writeFileSync(process.argv[4], JSON.stringify({
    tag_name: "feed",
    name: "feed",
    body: "Scorpio Agent update feed",
    target_commitish: "main"
  }));
} else if (kind === "feed") {
  fs.writeFileSync(process.argv[4], JSON.stringify({
    version: process.argv[5],
    notes,
    url: process.argv[6]
  }));
} else {
  process.exit(2);
}
'@
  $releaseBody = Join-Path $work "release.json"
  & node $jsonWriter release $NotesFile $releaseBody "v$Version"
  if ($LASTEXITCODE -ne 0) { throw "failed to write release json" }
  $created = Invoke-Api "POST" "$Api/releases" $releaseBody
  if ($created.Code -eq "409") {
    Write-Output "release v$Version already exists"
  } elseif ($created.Code -match "^2") {
    Write-Output "release v$Version created HTTP $($created.Code)"
  } else {
    throw "create release returned HTTP $($created.Code)"
  }

  $size = (Get-Item -LiteralPath $installer).Length
  Send-Upload "v$Version" $uploadName $installer
  Write-Output "installer uploaded $size bytes as $uploadName"

  $feed = Invoke-Api "GET" "$Api/releases/tags/feed"
  if ($feed.Code -eq "404") {
    $feedBody = Join-Path $work "feed-release.json"
    & node $jsonWriter feed-release $NotesFile $feedBody
    if ($LASTEXITCODE -ne 0) { throw "failed to write feed release json" }
    $feedCreated = Invoke-Api "POST" "$Api/releases" $feedBody
    if ($feedCreated.Code -notmatch "^2" -and $feedCreated.Code -ne "409") {
      throw "create feed release returned HTTP $($feedCreated.Code)"
    }
    Write-Output "feed release ready HTTP $($feedCreated.Code)"
  } elseif ($feed.Code -match "^2") {
    $existing = Find-NamedId (Read-JsonFile $feed.Path) "latest.json"
    if ($existing) {
      $deleted = Invoke-Api "DELETE" "$Api/releases/feed/attach_files/$existing"
      if ($deleted.Code -ne "204" -and $deleted.Code -ne "200" -and $deleted.Code -ne "404") {
        throw "delete latest.json returned HTTP $($deleted.Code)"
      }
      Write-Output "old latest.json deleted HTTP $($deleted.Code)"
    } else {
      Write-Output "no existing latest.json"
    }
  } else {
    throw "read feed release returned HTTP $($feed.Code)"
  }

  $feedFile = Join-Path $work "latest.json"
  & node $jsonWriter feed $NotesFile $feedFile $Version $publicInstaller
  if ($LASTEXITCODE -ne 0) { throw "failed to write latest.json" }
  Send-Upload "feed" "latest.json" $feedFile
  Write-Output "latest.json uploaded"

  $saved = Join-Path $work "public-latest.json"
  & curl.exe -sS -L -o $saved $publicFeed
  if ($LASTEXITCODE -ne 0) { throw "public feed download failed" }
  $public = Read-JsonFile $saved
  if ([string]$public.version -ne $Version) {
    throw "public feed version is $($public.version)"
  }
  $installerCode = (& curl.exe -sS -o NUL -w "%{http_code}" $publicInstaller).Trim()
  if ($installerCode -ne "302") {
    throw "public installer returned HTTP $installerCode"
  }
  Write-Output "public feed version $($public.version)"
  Write-Output "public feed notes $($public.notes)"
  Write-Output "public installer HTTP $installerCode"
  Write-Output "release page https://gitcode.com/wzd24/agent/releases/tag/v$Version"
} finally {
  $token = $null
  Remove-Item Env:GITCODE_TOKEN -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath $work -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}
