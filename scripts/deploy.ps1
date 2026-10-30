<#
.SYNOPSIS
  中文交互式部署助手。工作台只创建候选版本；Docker 模式可首次部署、更新和回滚。
.EXAMPLE
  pwsh -File scripts/deploy.ps1
.EXAMPLE
  pwsh -File scripts/deploy.ps1 -Action Check
#>
param(
    [ValidateSet('Menu', 'Init', 'Check', 'Deploy', 'Backup', 'Rollback', 'Health', 'Workbench', 'Update', 'VerifyDR')]
    [string]$Action = 'Menu',
    [switch]$AllowAuditRisk
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configFile = Join-Path $projectRoot '.deployment.local.json'
$envFile = Join-Path $projectRoot '.env.production.local'
$backupDir = Join-Path $projectRoot '.deployment-backups'
Set-Location -LiteralPath $projectRoot

function Say([string]$text) { Write-Host "`n$text" -ForegroundColor Cyan }
function Warn([string]$text) { Write-Host "警告：$text" -ForegroundColor Yellow }
function Need([string]$command) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "缺少 $command，请先安装并加入 PATH。" }
}
function Run([string]$command, [string[]]$arguments) {
    & $command @arguments
    if ($LASTEXITCODE -ne 0) { throw "$command 执行失败（退出码 $LASTEXITCODE）。" }
}
function Read-Default([string]$message, [string]$value) {
    $answer = Read-Host "$message [$value]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $value }
    return $answer.Trim()
}
function New-Secret([int]$bytes) {
    $buffer = New-Object byte[] $bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
function Save-Utf8([string]$path, [string]$content) {
    [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
}
function Load-Config {
    if (-not (Test-Path -LiteralPath $configFile)) { throw "尚未初始化。先运行：pwsh -File scripts/deploy.ps1 -Action Init" }
    return Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
}
function Validate-Config($cfg) {
    if ($cfg.ContainerName -notmatch '^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$') { throw '容器名称格式错误。' }
    if ($cfg.VolumeName -notmatch '^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$') { throw '数据卷名称格式错误。' }
    if ($cfg.HostDataPath) {
        $hostPath = [string]$cfg.HostDataPath
        if (-not [System.IO.Path]::IsPathFullyQualified($hostPath) -or $hostPath -match '[,\r\n"]') {
            throw '宿主机数据目录必须是无逗号、引号和换行的绝对路径。'
        }
        $resolved = [System.IO.Path]::GetFullPath($hostPath)
        if ($resolved -eq [System.IO.Path]::GetPathRoot($resolved)) { throw '不能将磁盘根目录映射为站点数据目录。' }
        if ((Test-Path -LiteralPath $resolved) -and -not (Test-Path -LiteralPath $resolved -PathType Container)) {
            throw '宿主机数据路径已存在，但不是目录。'
        }
    }
    if ([int]$cfg.Port -lt 1024 -or [int]$cfg.Port -gt 65535) { throw '端口必须为 1024-65535。' }
    $app = [uri]$cfg.AppUrl
    $site = [uri]$cfg.SiteUrl
    if ($app.Scheme -ne 'https' -or $site.Scheme -ne 'https' -or $app.AbsolutePath -ne '/' -or $site.AbsolutePath -ne '/' -or
        $app.UserInfo -or $site.UserInfo -or $app.Query -or $site.Query -or $app.Fragment -or $site.Fragment) {
        throw '应用和分享地址必须是没有凭据、查询和片段的 HTTPS 根地址。'
    }
}
function Initialize {
    Say '首次配置（配置仅保存在本机，不提交仓库）'
    if ((Test-Path $configFile) -or (Test-Path $envFile)) {
        $answer = Read-Host '配置文件已存在。输入“覆盖配置”才能重建（旧密钥会失效）'
        if ($answer -ne '覆盖配置') { Warn '已取消，原配置保留。'; return }
    }
    $app = Read-Default '应用 HTTPS 地址' 'https://play.linecode.top'
    $site = Read-Default '分享站点 HTTPS 地址' $app
    $port = Read-Default '本机 Docker 监听端口' '3001'
    $container = Read-Default 'Docker 容器名' 'linecode-html-playground'
    $volume = Read-Default 'Docker 数据卷名（宿主目录留空时使用）' 'linecode-html-playground-data'
    $defaultHostData = Join-Path $projectRoot 'data\sites'
    $hostDataPath = (Read-Default '宿主机本地映射数据目录（映射至容器 /data/sites）' $defaultHostData).Trim()
    $admin = Read-Default '管理员用户名' 'admin'
    $cfg = [pscustomobject]@{ AppUrl = $app.TrimEnd('/'); SiteUrl = $site.TrimEnd('/'); Port = [int]$port; ContainerName = $container; VolumeName = $volume; HostDataPath = $hostDataPath; ImagePrefix = 'linecode-html-playground' }
    Validate-Config $cfg
    if ($admin -notmatch '^[a-zA-Z0-9_.-]{3,64}$') { throw '管理员用户名只能包含字母、数字、点、下划线或短横线，长度 3-64。' }
    $password = New-Secret 32
    $session = New-Secret 48
    $lines = @(
        "ADMIN_USERNAME=$admin", "ADMIN_PASSWORD=$password", "ADMIN_SESSION_SECRET=$session",
        'SITES_DIR=/data/sites', 'SITE_DB_PATH=/data/sites/sites.db', 'SITE_RETENTION_DAYS=30',
        "SITE_PUBLIC_BASE_URL=$($cfg.SiteUrl)", "NEXT_PUBLIC_BASE_URL=$($cfg.AppUrl)"
    )
    Save-Utf8 $envFile (($lines -join "`n") + "`n")
    Save-Utf8 $configFile (($cfg | ConvertTo-Json -Depth 4) + "`n")
    # Windows ACL: only current user and SYSTEM can read deployment secrets.
    if ($env:OS -eq 'Windows_NT') {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        & icacls.exe $envFile '/inheritance:r' '/grant:r' "${identity}:F" 'SYSTEM:F' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '无法收紧密钥文件权限，请手工保护并检查该文件。' }
    }
    Say "配置已保存：$configFile"
    if ($cfg.HostDataPath) { Say "Docker 数据映射：$($cfg.HostDataPath) → /data/sites（SQLite：/data/sites/sites.db）" }
    else { Say "Docker 数据映射：命名卷 $($cfg.VolumeName) → /data/sites（SQLite：/data/sites/sites.db）" }
    Warn "管理员初始密码只在此处显示一次，请保存到密码管理器：$password"
    if ($cfg.AppUrl -eq $cfg.SiteUrl) { Warn '应用和用户分享页使用同一域名；上线后建议接入独立分享域名。' }
    Warn '工作台部署时，请把 .env.production.local 中的值手工填入工作台环境变量；不要上传此文件。'
}
function Check-Source {
    Say '代码和依赖安全检查'
    Need node
    $nodeVersion = (& node --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.(\d+)\.') { throw '无法读取 Node.js 版本。' }
    $nodeMajor = [int]$Matches[1]
    $nodeMinor = [int]$Matches[2]
    if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 13)) {
        throw "当前 $nodeVersion；SQLite 使用 node:sqlite，请安装 Node.js 22.13+ 或 24 后重试。"
    }
    Need npm
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
        Say '首次安装锁定依赖'
        Run npm @('ci', '--legacy-peer-deps', '--no-audit', '--no-fund')
    }
    Run npm @('run', 'typecheck')
    Run npm @('run', 'lint')
    Run npm @('test')
    Run npm @('run', 'build')
    Say '正在检查生产依赖漏洞（高危及以上阻止部署）'
    $auditOutput = @(& npm audit --json --omit=dev --audit-level=high --registry=https://registry.npmjs.org/ 2>&1)
    $auditExit = $LASTEXITCODE
    try { $audit = ($auditOutput -join "`n") | ConvertFrom-Json }
    catch { throw '依赖审计服务没有返回有效报告；无法确认安全状态。' }
    if ($audit.error -or -not $audit.metadata -or -not $audit.metadata.vulnerabilities) {
        throw "依赖审计服务失败：$($audit.error.message)"
    }
    $high = [int]$audit.metadata.vulnerabilities.high + [int]$audit.metadata.vulnerabilities.critical
    Write-Host "生产依赖审计：高危/严重 $high 项。"
    if ($auditExit -notin @(0, 1)) { throw "依赖审计进程失败（退出码 $auditExit），不能跳过。" }
    if ($high -gt 0) {
        if ($auditExit -ne 1) { throw '依赖审计报告与进程状态不一致，不能跳过。' }
        if (-not $AllowAuditRisk) { throw '高危依赖漏洞阻止部署。修复后重试；若已经评估并接受风险，可显式使用 -AllowAuditRisk。' }
        Warn '已按 -AllowAuditRisk 显式接受已报告的高危依赖风险；请尽快修复。'
    } elseif ($auditExit -ne 0) { throw "依赖审计进程失败（退出码 $auditExit）。" }
}
function Need-Docker {
    Need docker
    Run docker @('info', '--format', '{{.ServerVersion}}')
    $osType = (& docker info '--format' '{{.OSType}}').Trim()
    if ($osType -ne 'linux') { throw '请将 Docker 切换为 Linux 容器模式。' }
}
function Has-Container([string]$name) {
    & docker container inspect $name '--format' '{{.Id}}' 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}
function Ensure-Volume([string]$name) {
    & docker volume inspect $name '--format' '{{.Name}}' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Run docker @('volume', 'create', $name) }
}
function Storage-Mount($cfg, [string]$target, [switch]$ReadOnly) {
    $mount = if ($cfg.HostDataPath) {
        "type=bind,source=$($cfg.HostDataPath),target=$target"
    } else {
        "type=volume,source=$($cfg.VolumeName),target=$target"
    }
    if ($ReadOnly) { return "$mount,readonly" }
    return $mount
}
function Ensure-Storage($cfg) {
    if (-not $cfg.HostDataPath) { Ensure-Volume $cfg.VolumeName; return }
    $hostPath = [System.IO.Path]::GetFullPath([string]$cfg.HostDataPath)
    New-Item -ItemType Directory -Force -Path $hostPath | Out-Null
    $mount = Storage-Mount $cfg '/data/sites'
    & docker run --rm --network none --user 10001:10001 --read-only --mount $mount alpine:3.21 sh -c 'test -w /data/sites' | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "容器用户 10001 无法写入宿主机目录 $hostPath；请在 Docker 主机上调整该目录所有权或权限。"
    }
}
function Check-Health([string]$url) {
    $target = $url.TrimEnd('/') + '/healthz'
    for ($attempt = 1; $attempt -le 20; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $target -UseBasicParsing -TimeoutSec 5
            if ($response.StatusCode -eq 200) { Say "健康检查通过：$target"; return }
        } catch { Start-Sleep -Seconds 2 }
    }
    throw "健康检查未通过：$target"
}
function Backup-Volume($cfg) {
    Need-Docker
    if ($cfg.HostDataPath) {
        if (-not (Test-Path -LiteralPath $cfg.HostDataPath -PathType Container)) {
            throw "宿主机数据目录不存在，不能备份：$($cfg.HostDataPath)"
        }
    } else {
        & docker volume inspect $cfg.VolumeName '--format' '{{.Name}}' 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Docker 数据卷不存在，不能备份：$($cfg.VolumeName)" }
    }
    Ensure-Storage $cfg
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $archive = "$($cfg.ContainerName)-$stamp.tar.gz"
    $source = if ($cfg.HostDataPath) { $cfg.HostDataPath } else { $cfg.VolumeName }
    Say "正在备份站点数据：$source"
    # 必须只读挂载数据；运行中的 SQLite 在备份时可能变化，更新流程先停止旧容器。
    $dataMount = Storage-Mount $cfg '/source' -ReadOnly
    Run docker @('run', '--rm', '--network', 'none', '--read-only', '--mount', $dataMount, '--mount', "type=bind,source=$backupDir,target=/backup", 'alpine:3.21', 'tar', '-C', '/source', '-czf', "/backup/$archive", '.')
    $file = Join-Path $backupDir $archive
    if (-not (Test-Path -LiteralPath $file) -or (Get-Item -LiteralPath $file).Length -eq 0) { throw '备份文件为空或不存在。' }
    Say "备份完成：$file"
    return $file
}
function Docker-Run($cfg, [string]$image) {
    $dataMount = Storage-Mount $cfg '/data/sites'
    Run docker @('run', '-d', '--name', $cfg.ContainerName, '--restart', 'unless-stopped', '--user', '10001:10001', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m', '-p', "127.0.0.1:$($cfg.Port):3001", '--env-file', $envFile, '--mount', $dataMount, $image)
}
function Migrate-Database($cfg, [string]$image) {
    Say '备份后迁移历史站点元数据到 SQLite（幂等）'
    $dataMount = Storage-Mount $cfg '/data/sites'
    Run docker @('run', '--rm', '--network', 'none', '--user', '10001:10001', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m', '--env-file', $envFile, '--mount', $dataMount, '--entrypoint', 'node', $image, 'scripts/migrate-site-db.mjs')
}
function Deploy-Docker {
    $cfg = Load-Config
    Validate-Config $cfg
    if (-not (Test-Path -LiteralPath $envFile)) { throw "缺少密钥文件：$envFile" }
    Need-Docker
    Check-Source
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $image = "$($cfg.ImagePrefix):$stamp"
    Say "构建前后端一体镜像：$image"
    Run docker @('build', '--pull', '--platform', 'linux/amd64', '--tag', $image, '--build-arg', "NEXT_PUBLIC_BASE_URL=$($cfg.AppUrl)", '.')
    Ensure-Storage $cfg
    $oldImage = $null
    $hadOld = Has-Container $cfg.ContainerName
    if ($hadOld) {
        $oldImage = (& docker container inspect $cfg.ContainerName '--format' '{{.Config.Image}}').Trim()
        Run docker @('stop', '--time', '30', $cfg.ContainerName)
        try { Backup-Volume $cfg | Out-Null }
        catch { Run docker @('start', $cfg.ContainerName); throw }
        Run docker @('rm', $cfg.ContainerName)
    } else {
        # 第一次部署时卷也可能是预先导入的历史站点，迁移前必须保留快照。
        Backup-Volume $cfg | Out-Null
    }
    try {
        Migrate-Database $cfg $image
        Docker-Run $cfg $image
        Check-Health "http://127.0.0.1:$($cfg.Port)"
    } catch {
        $failure = $_
        if (Has-Container $cfg.ContainerName) { & docker rm -f $cfg.ContainerName | Out-Null }
        if ($oldImage) {
            Warn "新版本启动失败，正在恢复旧镜像 $oldImage。数据卷保持原样，未自动回滚数据库。"
            Docker-Run $cfg $oldImage
            Check-Health "http://127.0.0.1:$($cfg.Port)"
        }
        throw $failure
    }
    Say "部署完成。镜像：$image；本机入口：http://127.0.0.1:$($cfg.Port)"
    Warn '脚本仅绑定本机回环端口。外网 HTTPS、证书和反向代理须在你的服务器或工作台配置。'
}
function Rollback-Docker {
    $cfg = Load-Config
    Validate-Config $cfg
    Need-Docker
    if (-not (Has-Container $cfg.ContainerName)) { throw '当前没有可回滚的容器。' }
    $images = @(& docker image ls $cfg.ImagePrefix '--format' '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -notmatch ':<none>$' })
    if ($images.Count -lt 2) { throw '本机没有至少两个历史镜像。' }
    $current = (& docker container inspect $cfg.ContainerName '--format' '{{.Config.Image}}').Trim()
    Say "当前镜像：$current"
    $images | ForEach-Object { Write-Host "  $_" }
    $target = Read-Host '输入要回滚到的完整镜像标签'
    if ($target -eq $current -or $images -notcontains $target) { throw '请选择列表内另一个镜像。' }
    $confirm = Read-Host '回滚会停止服务并备份当前数据卷。输入“确认回滚”继续'
    if ($confirm -ne '确认回滚') { Warn '已取消。'; return }
    Run docker @('stop', '--time', '30', $cfg.ContainerName)
    try { Backup-Volume $cfg | Out-Null } catch { Run docker @('start', $cfg.ContainerName); throw }
    Run docker @('rm', $cfg.ContainerName)
    try { Docker-Run $cfg $target; Check-Health "http://127.0.0.1:$($cfg.Port)" }
    catch {
        $failure = $_
        if (Has-Container $cfg.ContainerName) { & docker rm -f $cfg.ContainerName | Out-Null }
        Docker-Run $cfg $current
        Check-Health "http://127.0.0.1:$($cfg.Port)"
        throw $failure
    }
    Say "已回滚镜像至 $target。数据卷和数据库未回退，请核对版本兼容性。"
}
function Trigger-Workbench {
    Say '工作台候选版本'
    Warn 'GitHub Actions 会运行类型检查、测试和官方 npm 高危依赖审计；未通过时不会推送候选镜像。'
    Need git
    Need gh
    $dirty = @(& git status --porcelain)
    if ($dirty.Count -gt 0) { throw '仓库有未提交改动。先提交并推送代码，再触发候选版本。' }
    $branch = (& git branch --show-current).Trim()
    if ($branch -ne 'main') { throw '当前不是 main 分支，工作台配置跟踪 main。' }
    Run gh @('auth', 'status')
    $remote = (& git ls-remote origin refs/heads/main)
    if ($LASTEXITCODE -ne 0 -or -not $remote) { throw '无法读取远程 main。' }
    $remoteSha = ($remote -split '\s+')[0]
    $localSha = (& git rev-parse HEAD).Trim()
    if ($remoteSha -ne $localSha) { throw '本地 HEAD 与远程 main 不一致，先同步并推送。' }
    $buildId = (Read-Host '工作台提供的 workbench_build_id（手动构建可留空）').Trim()
    if ($buildId -and $buildId -notmatch '^[a-zA-Z0-9_-]{1,128}$') { throw 'workbench_build_id 格式错误。' }
    $beforeRaw = & gh run list --workflow workbench-build.yml --event workflow_dispatch --json databaseId --limit 100
    if ($LASTEXITCODE -ne 0) { throw '无法读取 GitHub Actions 已有运行列表。' }
    $seen = @{}
    @(($beforeRaw -join "`n" | ConvertFrom-Json)) | ForEach-Object { $seen[[string]$_.databaseId] = $true }
    $confirmation = Read-Host '触发 GitHub Actions 构建候选镜像？输入“构建候选”继续'
    if ($confirmation -ne '构建候选') { Warn '已取消。'; return }
    $runArgs = @('workflow', 'run', 'workbench-build.yml', '--ref', 'main')
    if ($buildId) { $runArgs += @('-f', "workbench_build_id=$buildId") }
    if ($AllowAuditRisk) {
        Warn '本次手动候选构建将显式绕过高危依赖审计门槛；Actions 会标记该风险。'
        $runArgs += @('-f', 'allow_audit_risk=true')
    }
    Run gh $runArgs
    $runId = $null
    for ($attempt = 1; $attempt -le 15; $attempt++) {
        $raw = & gh run list --workflow workbench-build.yml --event workflow_dispatch --json databaseId,displayTitle,headSha --limit 100
        if ($LASTEXITCODE -ne 0) { throw '无法读取 GitHub Actions 运行列表。' }
        $expectedTitle = if ($buildId) { "workbench-$buildId" } else { "workbench-$localSha" }
        $matching = @(($raw -join "`n" | ConvertFrom-Json) | Where-Object {
            -not $seen.ContainsKey([string]$_.databaseId) -and $_.headSha -eq $localSha -and $_.displayTitle -eq $expectedTitle
        })
        if ($matching.Count -eq 1) { $runId = [string]$matching[0].databaseId; break }
        if ($matching.Count -gt 1) { throw '发现多个同一提交的候选运行，无法安全确定本次运行；请在 GitHub Actions 手工核对。' }
        Start-Sleep -Seconds 2
    }
    if (-not $runId) { throw '已触发候选构建，但暂未找到运行记录。请在 GitHub Actions 中继续查看。' }
    Say "等待候选构建完成：GitHub Actions run $runId"
    Run gh @('run', 'watch', $runId, '--exit-status')
    $artifactDir = Join-Path $projectRoot (".deployment-artifacts/$runId")
    New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
    Run gh @('run', 'download', $runId, '--name', 'workbench-release-de60514f-a192-41de-be55-f167c6a51d7c', '--dir', $artifactDir)
    $manifestFile = Join-Path $artifactDir 'workbench-release.json'
    if (-not (Test-Path -LiteralPath $manifestFile)) { throw '候选构建已结束，但缺少工作台发布清单。' }
    $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
    if ($manifest.application_id -ne 'de60514f-a192-41de-be55-f167c6a51d7c' -or
        $manifest.kind -ne 'container' -or $manifest.commit_sha -ne $localSha -or
        $manifest.build_id -ne $buildId -or
        $manifest.image -notmatch '^ghcr\.io/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$') {
        throw "候选清单字段或镜像摘要校验失败：$manifestFile"
    }
    Say "候选构建完成；镜像：$($manifest.image)"
    Say "清单：$manifestFile"
    Warn '工作台生产发布必须人工核对候选镜像、环境变量、证书、数据卷及 /healthz 后确认。脚本不调用未知的生产 API。'
}
function Backup-Running($cfg) {
    Need-Docker
    $wasRunning = $false
    if (Has-Container $cfg.ContainerName) {
        $state = (& docker container inspect $cfg.ContainerName '--format' '{{.State.Running}}').Trim()
        $wasRunning = ($state -eq 'true')
    }
    if ($wasRunning) { Run docker @('stop', '--time', '30', $cfg.ContainerName) }
    try { Backup-Volume $cfg | Out-Null }
    finally { if ($wasRunning) { Run docker @('start', $cfg.ContainerName) } }
}
function Update-From-GitHub {
    Say '>>> 从 GitHub 检查并拉取最新代码...'
    Need git
    $branch = (& git branch --show-current).Trim()
    if (-not $branch) { $branch = 'main' }
    $dirty = @(& git status --porcelain)
    if ($dirty.Count -gt 0) { throw '工作区有未提交的改动，请先提交或保存后再更新。' }
    Say "正在从 GitHub origin/$branch 快进拉取..."
    Run git @('fetch', '--prune', 'origin', $branch)
    Run git @('merge', '--ff-only', "origin/$branch")
    Say "已成功从 GitHub 更新至最新提交："
    & git log -1 --oneline
    Say "开始执行镜像重新构建与热切部署..."
    Deploy-Docker
}

function Verify-DR {
    Say '=== 灾备数据包非破坏性完整性校验 ==='
    if (-not (Test-Path -LiteralPath $backupDir -PathType Container)) {
        throw "备份目录不存在：$backupDir"
    }
    $archives = @(Get-ChildItem -LiteralPath $backupDir -Filter '*.tar.gz' | Sort-Object LastWriteTime -Descending)
    if ($archives.Count -eq 0) {
        throw "在备份目录中未找到任何 .tar.gz 备份包：$backupDir"
    }
    Say "可用灾备包："
    for ($i = 0; $i -lt $archives.Count; $i++) {
        $mb = [math]::Round($archives[$i].Length / 1MB, 2)
        Write-Host "  [$($i+1)] $($archives[$i].Name) ($mb MB, $($archives[$i].LastWriteTime))"
    }
    Write-Host "  [A] 全部校验"
    $choice = Read-Host "请选择要校验的灾备包 [1-$($archives.Count) 或 A]"
    $targets = @()
    if ($choice -match '^[aA]$') { $targets = $archives }
    elseif ($choice -match '^\d+$' -and [int]$choice -ge 1 -and [int]$choice -le $archives.Count) {
        $targets = @($archives[[int]$choice - 1])
    } else { throw '无效选择。' }

    $passed = 0
    $failed = 0
    foreach ($target in $targets) {
        Say "`n>>> 正在校验灾备包: $($target.Name)"
        $fail = $false
        # 1. 检查 sha256 文件
        $shaFile = "$($target.FullName).sha256"
        if (Test-Path -LiteralPath $shaFile) {
            $expected = (Get-Content -LiteralPath $shaFile -Raw).Split()[0].Trim()
            $actual = (Get-FileHash -LiteralPath $target.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($expected.ToLowerInvariant() -eq $actual) {
                Write-Host "  [√] SHA-256 校验和：匹配 ($actual)" -ForegroundColor Green
            } else {
                Warn "  [X] SHA-256 校验和不匹配！期望: $expected, 实际: $actual"
                $fail = $true
            }
        } else {
            Write-Host "  [i] 未检测到配套 .sha256 校验文件（跳过校验和比对）"
        }

        # 2. 调用 python 检查 tar 安全性
        try {
            $pyScript = """
import sys, tarfile, pathlib
with tarfile.open(sys.argv[1], 'r:gz') as tar:
    for m in tar:
        p = pathlib.PurePosixPath(m.name)
        if m.name.startswith('/') or '\\' in m.name or '..' in p.parts:
            sys.exit(2)
sys.exit(0)
"""
            $tempPy = [System.IO.Path]::GetTempFileName() + '.py'
            Save-Utf8 $tempPy $pyScript
            & python $tempPy $target.FullName
            Remove-Item $tempPy -Force -ErrorAction SilentlyContinue
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  [√] 压缩包结构：安全合规（无路径穿越或软链接）" -ForegroundColor Green
            } else {
                Warn "  [X] 压缩包包含非法穿越路径！"
                $fail = $true
            }
        } catch {
            Warn "  [X] 压缩包格式检验异常：$($_.Exception.Message)"
            $fail = $true
        }

        if (-not $fail) {
            Write-Host "  >>> 结论：灾备包 [$($target.Name)] 完整可用！" -ForegroundColor Green
            $passed++
        } else {
            Warn "  >>> 结论：灾备包 [$($target.Name)] 校验未通过！"
            $failed++
        }
    }
    Say "`n=== 灾备校验统计 ==="
    Write-Host "总数: $($targets.Count) | 通过: $passed | 异常: $failed"
    if ($failed -gt 0) { throw "发现 $failed 个损坏或不安全的灾备包！" }
}

function Main([string]$name) {
    switch ($name) {
        Init { Initialize }
        Check { Check-Source }
        Deploy { Deploy-Docker }
        Backup { $cfg = Load-Config; Validate-Config $cfg; Backup-Running $cfg }
        Rollback { Rollback-Docker }
        Health { $cfg = Load-Config; Validate-Config $cfg; Check-Health "http://127.0.0.1:$($cfg.Port)" }
        Workbench { Trigger-Workbench }
        Update { Update-From-GitHub }
        VerifyDR { Verify-DR }
    }
}

try {
    if ($Action -eq 'Menu') {
        while ($true) {
            Say '站点分享服务部署助手'
            Write-Host '1 首次配置  2 检查代码与安全  3 Docker 首次部署/更新  4 备份数据卷'
            Write-Host '5 回滚镜像  6 健康检查  7 触发工作台候选构建  8 灾备完整性校验'
            Write-Host '9 从 GitHub 拉取更新  0 退出'
            $choice = Read-Host '请选择'
            $selected = switch ($choice) {
                '1' { 'Init' } '2' { 'Check' } '3' { 'Deploy' } '4' { 'Backup' }
                '5' { 'Rollback' } '6' { 'Health' } '7' { 'Workbench' }
                '8' { 'VerifyDR' } '9' { 'Update' } '0' { return } default { $null }
            }
            if (-not $selected) { Warn '无效选项。'; continue }
            try { Main $selected } catch { Write-Host "失败：$($_.Exception.Message)" -ForegroundColor Red }
        }
    } else { Main $Action }
} catch {
    Write-Host "失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
