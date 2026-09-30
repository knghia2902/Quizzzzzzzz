$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir = Join-Path $Root '.runtime-logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$env:QUIZ_TTS_ADMIN_TOKEN = [guid]::NewGuid().ToString('N')
$AdminCredentialFile = Join-Path $Root '.admin-credentials.json'
$AdminUser = [string]$env:QUIZ_ADMIN_USER
$AdminPassword = [string]$env:QUIZ_ADMIN_PASSWORD
$AdminMustChange = if ($env:QUIZ_ADMIN_MUST_CHANGE) { [System.Convert]::ToBoolean($env:QUIZ_ADMIN_MUST_CHANGE) } else { $true }
if (!$AdminUser -or !$AdminPassword) {
  if (Test-Path $AdminCredentialFile) {
    try {
      $storedCredentials = Get-Content -Raw $AdminCredentialFile | ConvertFrom-Json
      if (!$AdminUser) { $AdminUser = [string]$storedCredentials.username }
      if (!$AdminPassword) { $AdminPassword = [string]$storedCredentials.password }
      if ($null -ne $storedCredentials.must_change) { $AdminMustChange = [bool]$storedCredentials.must_change }
      else { $AdminPassword = 'admin'; $AdminMustChange = $true }
    } catch { }
  }
}
if (!$AdminUser) { $AdminUser = 'admin' }
if (!$AdminPassword) {
  $AdminPassword = 'admin'
  $AdminMustChange = $true
}
$credentialsPayload = @{ username = $AdminUser; password = $AdminPassword; must_change = $AdminMustChange } | ConvertTo-Json
Set-Content -Path $AdminCredentialFile -Value $credentialsPayload -Encoding utf8
$env:QUIZ_ADMIN_USER = $AdminUser
$env:QUIZ_ADMIN_PASSWORD = $AdminPassword
$env:QUIZ_ADMIN_MUST_CHANGE = [string]$AdminMustChange
$env:QUIZ_ADMIN_SESSION_SECRET = $env:QUIZ_TTS_ADMIN_TOKEN
$PagesVars = Join-Path $Root '.dev.vars'
$HadPagesVars = Test-Path $PagesVars
$PreviousPagesVars = if ($HadPagesVars) { Get-Content -Raw $PagesVars } else { $null }
Set-Content -Path $PagesVars -Value "QUIZ_TTS_ADMIN_TOKEN=$env:QUIZ_TTS_ADMIN_TOKEN`nQUIZ_ADMIN_USER=$env:QUIZ_ADMIN_USER`nQUIZ_ADMIN_PASSWORD=$env:QUIZ_ADMIN_PASSWORD`nQUIZ_ADMIN_MUST_CHANGE=$env:QUIZ_ADMIN_MUST_CHANGE`nQUIZ_ADMIN_SESSION_SECRET=$env:QUIZ_ADMIN_SESSION_SECRET`nLOCAL_TTS_BASE_URL=http://127.0.0.1:8786`n" -Encoding utf8

$children = @()

function Stop-ExistingQuizProcesses {
  $targets = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and
    $_.Name -in @('cmd.exe', 'node.exe', 'cloudflared.exe', 'py.exe', 'python.exe') -and
    (
      $_.CommandLine -match 'wrangler.*--port 8787' -or
      $_.CommandLine -match 'wrangler.*--port 8788' -or
      $_.CommandLine -match 'quiz-natime\.yml' -or
      $_.CommandLine -match 'presentation[\\/]local-tts[\\/]server\.py' -or
      $_.CommandLine -match 'elevenlabs-api-tool[\\/]app\.py' -or
      $_.CommandLine -match 'uvicorn.*--port\s+5050'
    )
  } | Select-Object -ExpandProperty ProcessId -Unique

  foreach ($processId in $targets) {
    if ($processId -and $processId -ne $PID) {
      try {
        $stillRunning = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($stillRunning) {
          & taskkill.exe /PID $processId /T /F 2>$null 1>$null
        }
      } catch {
        # Process may have exited between the inventory and taskkill.
      }
    }
  }
  if ($targets.Count -gt 0) { Start-Sleep -Seconds 2 }
}

function Start-QuizChild {
  param(
    [string]$Name,
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory = $Root
  )

  $stdout = Join-Path $LogDir "$Name.out.log"
  $stderr = Join-Path $LogDir "$Name.err.log"
  $process = Start-Process -FilePath $FilePath `
    -ArgumentList $ArgumentList `
    -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru
  $script:children += $process
  Write-Host "[$Name] started (logs: $stdout)" -ForegroundColor DarkGray
}

function Test-LocalHttp {
  param([string]$Url)
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

try {
  Stop-ExistingQuizProcesses
  Start-QuizChild 'quiz-worker' 'npx.cmd' @(
    'wrangler', 'dev', '--config', 'presentation/workers/wrangler.toml',
    '--local', '--port', '8787'
  )
  Start-QuizChild 'quiz-pages' 'npx.cmd' @(
    'wrangler', 'pages', 'dev', '.',
    '--do', 'QUIZ_ROOM=QuizRoom@quiz-room-worker', '--port', '8788'
  )
  Start-QuizChild 'quiz-tunnel' 'cloudflared.exe' @(
    'tunnel', '--config', "$env:USERPROFILE\.cloudflared\quiz-natime.yml", 'run'
  )

  Write-Host ''
  Write-Host 'Quizzzzzzzz dang chay:' -ForegroundColor Green
  Write-Host '  Local:  http://127.0.0.1:8788/'
  Write-Host '  Admin:  http://127.0.0.1:8788/admin'
  Write-Host '  Public: https://quiz.natime.vn/'
  Write-Host "  Admin user: $env:QUIZ_ADMIN_USER" -ForegroundColor Cyan
  Write-Host "  Admin pass: $env:QUIZ_ADMIN_PASSWORD" -ForegroundColor Cyan
  Write-Host ''
  Write-Host 'TTS VietVoice, OmniVoice va ElevenLabs da duoc tich hop trong Quiz.' -ForegroundColor Green
  Write-Host 'Nhan Ctrl+C de dung tat ca service.' -ForegroundColor Yellow
  Write-Host ''

  & py (Join-Path $Root 'presentation/local-tts/server.py')
}
finally {
  foreach ($process in $children) {
    try {
      if (!$process.HasExited) {
        & taskkill.exe /PID $process.Id /T /F *> $null
      }
    } catch { }
  }
  if ($HadPagesVars) {
    Set-Content -Path $PagesVars -Value $PreviousPagesVars -Encoding utf8
  } else {
    Remove-Item -LiteralPath $PagesVars -Force -ErrorAction SilentlyContinue
  }
  Write-Host 'Da dung cac service Quizzzzzzzz.' -ForegroundColor DarkGray
}
