#!/usr/bin/env bash
# Linux 单机部署控制台：Next.js 前后端一体容器、SQLite + 上传目录。
set -Eeuo pipefail
IFS=$'\n\t'

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
STATE_DIR=/etc/linecode-html-playground
CONFIG_FILE="$STATE_DIR/deploy.conf"
ENV_FILE="$STATE_DIR/app.env"
NGINX_FILE=/etc/nginx/conf.d/linecode-html-playground.conf
MANAGED_MARKER='# managed-by-linecode-server-deploy'
CONTAINER_PREFIX=linecode-html-playground
IMAGE_PREFIX=linecode-html-playground
ACTIVE_FILE="$STATE_DIR/active-slot"

say() { printf '\n\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m警告：%s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m失败：%s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少 $1，请在服务器安装后重试。"; }
ask() { local answer; read -r -p "$1 [$2]: " answer; printf '%s' "${answer:-$2}"; }
confirm() { local answer; read -r -p "$1（输入“$2”确认）: " answer; [[ "$answer" == "$2" ]]; }
root_only() { [[ "$(id -u)" == 0 ]] || die '请以 sudo 或 root 运行，脚本需配置 Docker 数据目录及 Nginx。'; }
valid_host() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ && "$1" != *..* ]]; }
valid_path() {
  [[ "$1" == /* && "$1" != / && "$1" != *$'\n'* && "$1" != *$'\r'* && "$1" != *','* ]] || return 1
  local part
  local -a parts
  IFS='/' read -r -a parts <<< "$1"
  for part in "${parts[@]}"; do [[ "$part" != '..' && "$part" != '.' ]] || return 1; done
  [[ "$1" == "$(realpath -m -- "$1")" ]]
}
validate_config() {
  valid_host "$APP_DOMAIN" || die '应用域名格式错误。'
  valid_host "$SITE_DOMAIN" || die '分享域名格式错误。'
  valid_path "$DATA_DIR" && valid_path "$BACKUP_DIR" || die '数据和备份目录必须是安全的绝对路径。'
  local blocked path
  for path in "$DATA_DIR" "$BACKUP_DIR"; do
    for blocked in /etc /usr /bin /sbin /var/lib/docker /proc /sys /dev; do
      [[ "$path" != "$blocked" && "$path" != "$blocked"/* ]] || die "禁止将系统目录用于数据或备份：$path"
    done
  done
  [[ "$DATA_DIR" != "$BACKUP_DIR" && "$DATA_DIR" != "$BACKUP_DIR"/* && "$BACKUP_DIR" != "$DATA_DIR"/* ]] || die '数据与备份目录不能互相包含。'
  [[ "$TLS_MODE" == existing || "$TLS_MODE" == selfsigned ]] || die 'TLS 模式错误。'
  [[ "$CERT_FILE" =~ ^/[a-zA-Z0-9_./-]+$ && "$KEY_FILE" =~ ^/[a-zA-Z0-9_./-]+$ ]] || die '证书和私钥路径必须是安全的绝对路径。'
  [[ "$GIT_BRANCH" =~ ^[a-zA-Z0-9._/-]+$ && "$GIT_BRANCH" != -* && "$GIT_BRANCH" != *..* ]] || die 'Git 分支名称格式错误。'
  [[ -z "$GIT_REPO_URL" || "$GIT_REPO_URL" =~ ^(https://|git@)[a-zA-Z0-9_.:/-]+ ]] || die 'Git 仓库地址格式错误（支持 HTTPS/SSH GitHub 地址）。'
}
load_config() {
  [[ -f "$CONFIG_FILE" && -f "$ENV_FILE" ]] || die '尚未初始化。请先运行菜单 1。'
  [[ ! -L "$STATE_DIR" && ! -L "$CONFIG_FILE" && ! -L "$ENV_FILE" ]] || die '部署配置路径不能是符号链接。'
  [[ "$(stat -c %u "$STATE_DIR")" == 0 && "$(stat -c %a "$STATE_DIR")" == 700 ]] || die '部署配置目录所有者或权限不安全。'
  # 仅读取固定键；配置文件内容绝不作为 shell 指令执行。
  [[ "$(stat -c %u "$CONFIG_FILE")" == 0 && "$(stat -c %a "$CONFIG_FILE")" =~ ^(600|400)$ ]] || die '部署配置所有者或权限不安全。'
  local key value
  APP_DOMAIN=''; SITE_DOMAIN=''; DATA_DIR=''; BACKUP_DIR=''; TLS_MODE=''; CERT_FILE=''; KEY_FILE=''; GIT_BRANCH=''; GIT_REPO_URL=''
  while IFS='=' read -r key value; do
    case "$key" in
      APP_DOMAIN) APP_DOMAIN="$value";; SITE_DOMAIN) SITE_DOMAIN="$value";;
      DATA_DIR) DATA_DIR="$value";; BACKUP_DIR) BACKUP_DIR="$value";;
      TLS_MODE) TLS_MODE="$value";; CERT_FILE) CERT_FILE="$value";;
      KEY_FILE) KEY_FILE="$value";; GIT_BRANCH) GIT_BRANCH="$value";;
      GIT_REPO_URL) GIT_REPO_URL="$value";;
      '') ;; *) die "部署配置包含未知字段：$key";;
    esac
  done < "$CONFIG_FILE"
  if [[ -z "$GIT_REPO_URL" && -d "$PROJECT_DIR/.git" ]]; then
    GIT_REPO_URL="$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null || true)"
  fi
  validate_config
}
preflight() {
  need docker; need curl; need git; need tar; need openssl; need nginx; need systemctl; need realpath; need python3
  docker info >/dev/null 2>&1 || die 'Docker 服务不可用。'
  [[ "$(docker info --format '{{.OSType}}')" == linux ]] || die '需要 Linux Docker Engine。'
  [[ "$(uname -m)" == x86_64 ]] || die '当前脚本仅支持 Linux amd64。'
  nginx -t >/dev/null 2>&1 || die '当前 Nginx 配置检查失败。'
}
write_config() {
  [[ ! -L "$STATE_DIR" ]] || die '部署配置目录不能是符号链接。'
  install -d -m 700 "$STATE_DIR"
  local tmp; tmp="$(mktemp "$STATE_DIR/config.XXXXXX")"
  chmod 600 "$tmp"
  {
    printf 'APP_DOMAIN=%s\nSITE_DOMAIN=%s\nDATA_DIR=%s\nBACKUP_DIR=%s\nTLS_MODE=%s\nCERT_FILE=%s\nKEY_FILE=%s\nGIT_BRANCH=%s\nGIT_REPO_URL=%s\n' \
      "$APP_DOMAIN" "$SITE_DOMAIN" "$DATA_DIR" "$BACKUP_DIR" "$TLS_MODE" "$CERT_FILE" "$KEY_FILE" "$GIT_BRANCH" "$GIT_REPO_URL"
  } > "$tmp"
  mv -f -- "$tmp" "$CONFIG_FILE"
}
write_env() {
  local password secret tmp
  password="$(openssl rand -hex 24)"; secret="$(openssl rand -hex 48)"
  tmp="$(mktemp "$STATE_DIR/env.XXXXXX")"; chmod 600 "$tmp"
  {
    printf 'ADMIN_USERNAME=admin\nADMIN_PASSWORD=%s\nADMIN_SESSION_SECRET=%s\n' "$password" "$secret"
    printf 'SITES_DIR=/data/sites\nSITE_DB_PATH=/data/sites/sites.db\nSITE_RETENTION_DAYS=30\n'
    printf 'SITE_PUBLIC_BASE_URL=https://%s\nNEXT_PUBLIC_BASE_URL=https://%s\n' "$SITE_DOMAIN" "$APP_DOMAIN"
  } > "$tmp"
  mv -f -- "$tmp" "$ENV_FILE"
  say "管理员初始用户名：admin；密码（仅显示一次）：$password"
}
prepare_storage() {
  [[ ! -e "$DATA_DIR" || -d "$DATA_DIR" ]] || die '数据路径已存在且不是目录。'
  [[ ! -e "$BACKUP_DIR" || -d "$BACKUP_DIR" ]] || die '备份路径已存在且不是目录。'
  install -d -m 750 "$DATA_DIR" "$BACKUP_DIR"
  # 不接管已有数据目录所有权；仅新建空目录可安全赋权。
  if [[ -z "$(ls -A "$DATA_DIR")" ]]; then chown 10001:10001 "$DATA_DIR"; fi
  docker run --rm --network none --user 10001:10001 --read-only \
    --mount "type=bind,src=$DATA_DIR,dst=/data/sites" alpine:3.21 \
    sh -c 'test -w /data/sites' >/dev/null || die '容器 UID 10001 无法写入宿主机本地映射数据目录。'
  say "========================================================="
  say " 宿主机本地映射目录检查 (Host Directory Mapping):"
  say "   [宿主机] 本地数据目录: $DATA_DIR"
  say "   [容器内] 挂载目标路径: /data/sites"
  say "   [持久化] SQLite 数据库: $DATA_DIR/sites.db"
  say "   [持久化] 站点静态文件: $DATA_DIR/<site-name>/*"
  say "   已验证容器 UID 10001:10001 具备读写权限；"
  say "   容器销毁/升级/重建时，数据仍完好保存在宿主机本地目录中。"
  say "========================================================="
}
prepare_tls() {
  if [[ "$TLS_MODE" == existing ]]; then
    [[ -f "$CERT_FILE" && -f "$KEY_FILE" ]] || die '证书或私钥不存在。'
  else
    if [[ -e "$CERT_FILE" || -e "$KEY_FILE" ]]; then
      [[ -f "$CERT_FILE" && -f "$KEY_FILE" ]] || die '自签证书路径部分存在；不会覆盖。'
    else
      install -d -m 700 "$(dirname "$CERT_FILE")"
      openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 30 \
        -keyout "$KEY_FILE" -out "$CERT_FILE" -subj "/CN=$APP_DOMAIN" \
        -addext "subjectAltName=DNS:$APP_DOMAIN,DNS:$SITE_DOMAIN" >/dev/null 2>&1
      chmod 600 "$KEY_FILE"; chmod 644 "$CERT_FILE"
      warn '生成了 30 天自签证书，仅适合临时测试；浏览器不会信任。正式上线请更换受信任证书。'
    fi
  fi
  openssl x509 -in "$CERT_FILE" -noout -checkend 604800 >/dev/null || warn '证书将在 7 天内过期。'
}
write_nginx() {
  local port="$1" tmp
  [[ ! -L "$NGINX_FILE" ]] || die 'Nginx 托管配置不能是符号链接。'
  if [[ -e "$NGINX_FILE" ]] && ! grep -Fqx "$MANAGED_MARKER" "$NGINX_FILE"; then
    die "Nginx 文件已存在但不属于本脚本：$NGINX_FILE。不会覆盖。"
  fi
  if [[ ! -e "$NGINX_FILE" ]]; then
    if ! nginx -T 2>/dev/null | python3 -c '
import re, sys
hosts = set(sys.argv[1:])
for line in sys.stdin:
    match = re.search(r"^\s*server_name\s+([^;]+);", line)
    if match and hosts.intersection(match.group(1).split()):
        sys.exit(1)
' "$APP_DOMAIN" "$SITE_DOMAIN"; then
      die '已有其他 Nginx 站点使用相同域名；不会添加重复代理配置。请先手工迁移现有站点。'
    fi
  fi
  tmp="$(mktemp /etc/nginx/conf.d/.linecode.XXXXXX)"
  cat > "$tmp" <<EOF
$MANAGED_MARKER
server {
  listen 80;
  server_name $APP_DOMAIN $SITE_DOMAIN;
  return 301 https://\$host\$request_uri;
}
server {
  listen 443 ssl http2;
  server_name $APP_DOMAIN $SITE_DOMAIN;
  ssl_certificate $CERT_FILE;
  ssl_certificate_key $KEY_FILE;
  client_max_body_size 12m;
  location / {
    proxy_pass http://127.0.0.1:$port;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 60s;
  }
}
EOF
  chmod 644 "$tmp"
  local prior=''
  if [[ -e "$NGINX_FILE" ]]; then prior="$(mktemp "$STATE_DIR/nginx.XXXXXX")"; cp -p -- "$NGINX_FILE" "$prior"; fi
  mv -f -- "$tmp" "$NGINX_FILE"
  if ! nginx -t >/dev/null 2>&1; then
    if [[ -n "$prior" ]]; then mv -f -- "$prior" "$NGINX_FILE"; else rm -f -- "$NGINX_FILE"; fi
    die '新 Nginx 配置检查失败，原配置已保留。'
  fi
  if systemctl is-active --quiet nginx; then
    if ! systemctl reload nginx; then
      if [[ -n "$prior" ]]; then mv -f -- "$prior" "$NGINX_FILE"; else rm -f -- "$NGINX_FILE"; fi
      nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
      die 'Nginx 重载失败；原配置已恢复。'
    fi
  elif ! systemctl start nginx; then
    if [[ -n "$prior" ]]; then mv -f -- "$prior" "$NGINX_FILE"; else rm -f -- "$NGINX_FILE"; fi
    die 'Nginx 启动失败；原配置已恢复。'
  fi
  [[ -z "$prior" ]] || rm -f -- "$prior"
}
container_name() { printf '%s-%s' "$CONTAINER_PREFIX" "$1"; }
slot_port() { if [[ "$1" == blue ]]; then printf 3001; else printf 3002; fi; }
active_slot() { if [[ -f "$ACTIVE_FILE" ]]; then cat "$ACTIVE_FILE"; else printf ''; fi; }
container_exists() { docker container inspect "$(container_name "$1")" >/dev/null 2>&1; }
container_running() { [[ "$(docker inspect -f '{{.State.Running}}' "$(container_name "$1")" 2>/dev/null || true)" == true ]]; }
health_port() {
  local port="$1" i
  for i in {1..30}; do
    if curl --silent --fail --max-time 3 "http://127.0.0.1:$port/healthz" >/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}
build_image() {
  local tag="$IMAGE_PREFIX:$(date -u +%Y%m%d%H%M%S)-$(git -C "$PROJECT_DIR" rev-parse --short=12 HEAD)"
  say "构建前后端一体镜像：$tag" >&2
  docker build --pull --platform linux/amd64 --build-arg "NEXT_PUBLIC_BASE_URL=https://$APP_DOMAIN" -t "$tag" "$PROJECT_DIR" >&2
  printf '%s' "$tag"
}
start_slot() {
  local slot="$1" image="$2" port
  port="$(slot_port "$slot")"
  container_exists "$slot" && die "候选容器 $(container_name "$slot") 已存在，请先在菜单 7 检查。"
  docker run -d --name "$(container_name "$slot")" --restart unless-stopped \
    --user 10001:10001 --read-only --tmpfs /tmp:rw,nosuid,nodev,size=128m \
    --security-opt no-new-privileges --cap-drop ALL --pids-limit 256 \
    --publish "127.0.0.1:$port:3001" --env-file "$ENV_FILE" \
    --mount "type=bind,src=$DATA_DIR,dst=/data/sites" "$image" >/dev/null
  health_port "$port" || { docker logs --tail 50 "$(container_name "$slot")" >&2 || true; die '候选容器健康检查失败，流量未切换。'; }
}
rotate_backups() {
  valid_path "$BACKUP_DIR" || die '备份目录不安全，拒绝轮转。'
  [[ -d "$BACKUP_DIR" && "$(stat -c %u "$BACKUP_DIR")" == 0 ]] || die '备份目录必须由 root 拥有。'
  local -a archives=()
  local file i
  mapfile -t archives < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'linecode-*.tar.gz' -printf '%f\n' | sort -r)
  for ((i=14; i<${#archives[@]}; i++)); do
    file="$BACKUP_DIR/${archives[$i]}"
    [[ -f "$file" && ! -L "$file" && "$file" == "$BACKUP_DIR"/linecode-*.tar.gz ]] || die '轮转目标不安全。'
    if [[ -f "$file.sha256" && ! -L "$file.sha256" ]]; then
      rm -- "$file" "$file.sha256"
    else
      warn "缺少校验文件，保留历史备份：$file"
    fi
  done
}
backup_data() {
  load_config; need docker; need tar; need sha256sum; prepare_storage
  local slot archive stamp
  local -a running_slots=()
  for slot in blue green; do
    if container_running "$slot"; then
      running_slots+=("$slot")
      docker stop --time 30 "$(container_name "$slot")" >/dev/null
    fi
  done
  stamp="$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 4)"
  archive="$BACKUP_DIR/linecode-$stamp.tar.gz"
  local result=0
  tar -C "$DATA_DIR" -czf "$archive" . || result=1
  if [[ "$result" == 0 ]]; then
    chmod 600 "$archive" || result=1
    sha256sum "$archive" > "$archive.sha256" || result=1
    chmod 600 "$archive.sha256" || result=1
  fi
  local started attempt restart_failed=0
  for slot in "${running_slots[@]}"; do
    started=0
    for attempt in 1 2 3; do
      if docker start "$(container_name "$slot")" >/dev/null; then started=1; break; fi
      sleep 2
    done
    if [[ "$started" == 0 ]] || ! health_port "$(slot_port "$slot")"; then restart_failed=1; warn "备份后槽位 $slot 未恢复健康。"; fi
  done
  [[ "$restart_failed" == 0 ]] || die '备份已结束，但至少一个容器未恢复健康，请立即检查日志。'
  [[ "$result" == 0 ]] || die '备份失败，旧服务已尝试恢复。'
  rotate_backups
  say "一致性备份完成：$archive（备份期间服务短暂停止）"
}
audit_dependencies() {
  say '执行官方 npm 生产依赖审计（高危门槛）'
  local rc=0 report high
  report="$(mktemp)"
  docker run --rm --platform linux/amd64 --mount "type=bind,src=$PROJECT_DIR,dst=/src,readonly" \
    --workdir /src node:24-bookworm-slim npm audit --json --omit=dev --audit-level=high \
    --package-lock-only --registry=https://registry.npmjs.org/ > "$report" || rc=$?
  high="$(python3 - "$report" <<'PY'
import json, sys
try:
    audit = json.load(open(sys.argv[1], encoding="utf-8"))
    assert not audit.get("error")
    counts = audit["metadata"]["vulnerabilities"]
    print(int(counts["high"]) + int(counts["critical"]))
except Exception:
    sys.exit(2)
PY
)" || { rm -f -- "$report"; die '依赖审计未返回有效报告，拒绝部署。'; }
  rm -f -- "$report"
  if ((high > 0)) && [[ "$rc" == 1 ]]; then
    warn "审计发现 $high 项高危或严重漏洞。"
    confirm '确认已评估风险并继续部署' '接受高危风险' || die '高危依赖风险阻止部署。'
  elif [[ "$rc" != 0 || "$high" != 0 ]]; then die "审计报告与进程状态不一致或审计失败（退出码 $rc）。"; fi
}
run_migration() {
  local image="$1"
  say '执行幂等 SQLite 历史元数据迁移'
  docker run --rm --network none --user 10001:10001 --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,size=128m --env-file "$ENV_FILE" \
    --mount "type=bind,src=$DATA_DIR,dst=/data/sites" --entrypoint node \
    "$image" scripts/migrate-site-db.mjs
}
deploy_new() {
  root_only; load_config; preflight; prepare_storage; prepare_tls; audit_dependencies
  local old new image old_name
  old="$(active_slot)"
  if [[ "$old" != blue && "$old" != green ]]; then old=''; new=blue; else
    new=green; [[ "$old" == green ]] && new=blue
    backup_data
  fi
  image="$(build_image)"
  run_migration "$image"
  if container_exists "$new"; then
    # 只删除脚本自身命名的闲置槽，不涉及数据卷；仍须明确确认。
    confirm "闲置槽 $(container_name "$new") 已存在，是否替换" '替换闲置槽' || die '已取消。'
    docker rm -f "$(container_name "$new")" >/dev/null
  fi
  start_slot "$new" "$image"
  write_nginx "$(slot_port "$new")"
  printf '%s\n' "$new" > "$ACTIVE_FILE"; chmod 600 "$ACTIVE_FILE"
  if [[ -n "$old" ]] && container_running "$old"; then
    # Nginx reload 后保留短暂排空窗口，旧镜像及容器保留用于回退。
    sleep 5; docker stop --time 30 "$(container_name "$old")" >/dev/null
  fi
  say "部署完成：$image；当前槽位 $new；HTTPS 域名 https://$APP_DOMAIN"
}
git_update() {
  load_config; need git
  [[ -d "$PROJECT_DIR/.git" ]] || die '项目目录不是 Git 工作区。'
  say ">>> 同步与检查 GitHub 远程代码..."
  if [[ -n "$GIT_REPO_URL" ]]; then
    local current_remote
    current_remote="$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null || true)"
    if [[ "$current_remote" != "$GIT_REPO_URL" ]]; then
      if git -C "$PROJECT_DIR" remote | grep -qx origin; then
        git -C "$PROJECT_DIR" remote set-url origin "$GIT_REPO_URL"
      else
        git -C "$PROJECT_DIR" remote add origin "$GIT_REPO_URL"
      fi
      say "已配置 Git 远程仓库 origin -> $GIT_REPO_URL"
    fi
  fi
  [[ -z "$(git -C "$PROJECT_DIR" status --porcelain)" ]] || die '工作区有未提交改动，拒绝更新。'
  local current_branch
  current_branch="$(git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || true)"
  if [[ -n "$current_branch" && "$current_branch" != "$GIT_BRANCH" ]]; then
    git -C "$PROJECT_DIR" checkout "$GIT_BRANCH" || die "无法切换到分支 $GIT_BRANCH。"
  fi
  say "正在从 GitHub 拉取分支 $GIT_BRANCH 最新代码..."
  git -C "$PROJECT_DIR" fetch --prune origin "$GIT_BRANCH"
  git -C "$PROJECT_DIR" merge --ff-only "origin/$GIT_BRANCH" || die '无法快进更新，请手工处理分支。'
  say "成功拉取 GitHub 最新提交：$(git -C "$PROJECT_DIR" log -1 --oneline)"
  deploy_new
}
security_check() {
  root_only; load_config; preflight
  say '安全检查'
  stat -c '%a %U %n' "$CONFIG_FILE" "$ENV_FILE" "$DATA_DIR" "$BACKUP_DIR"
  [[ "$(stat -c %a "$ENV_FILE")" == 600 ]] || warn '密钥文件权限应为 600。'
  local admin_password='' session_secret='' env_key env_value
  while IFS='=' read -r env_key env_value; do
    case "$env_key" in
      ADMIN_PASSWORD) admin_password="$env_value";;
      ADMIN_SESSION_SECRET) session_secret="$env_value";;
    esac
  done < "$ENV_FILE"
  ((${#admin_password}>=20)) || warn '管理员密码短于 20 字符，请更换强随机密码。'
  ((${#session_secret}>=64)) || warn '会话密钥短于 64 字符，请更换。'
  openssl x509 -in "$CERT_FILE" -noout -dates || warn '证书读取失败。'
  openssl x509 -in "$CERT_FILE" -noout -checkend 604800 >/dev/null || warn '证书将在 7 天内过期。'
  local slot; slot="$(active_slot)"
  if [[ "$slot" == blue || "$slot" == green ]]; then
    docker inspect -f '容器端口：{{json .NetworkSettings.Ports}}；只读根：{{.HostConfig.ReadonlyRootfs}}；用户：{{.Config.User}}' "$(container_name "$slot")" || true
    local port_bind; port_bind="$(docker inspect -f '{{(index .NetworkSettings.Ports "3001/tcp" 0).HostIp}}' "$(container_name "$slot")" 2>/dev/null || true)"
    [[ "$port_bind" == 127.0.0.1 ]] || warn '容器端口并非仅绑定 127.0.0.1。'
  fi
  audit_dependencies_check
  if confirm '将密钥文件权限和数据目录权限收紧到推荐值' '确认加固'; then
    chmod 600 "$CONFIG_FILE" "$ENV_FILE"; chmod 750 "$DATA_DIR" "$BACKUP_DIR"
    say '权限加固完成；未修改防火墙和现有 Nginx 配置。'
  fi
}
audit_dependencies_check() {
  local rc=0
  docker run --rm --platform linux/amd64 --mount "type=bind,src=$PROJECT_DIR,dst=/src,readonly" \
    --workdir /src node:24-bookworm-slim npm audit --omit=dev --audit-level=high \
    --package-lock-only --registry=https://registry.npmjs.org/ || rc=$?
  if [[ "$rc" == 1 ]]; then warn '官方 npm 审计发现高危或严重漏洞。'
  elif [[ "$rc" != 0 ]]; then warn "官方 npm 审计不可用（退出码 $rc）。"; fi
}
verify_archive_integrity() {
  local target_file="$1"
  say ">>> 校验灾备包安全性与完整性: $(basename "$target_file")"

  # 1. 基础文件属性与符号链接
  [[ ! -L "$target_file" && -f "$target_file" ]] || { warn "备份文件是符号链接或非普通文件。"; return 1; }

  # 2. SHA-256 校验和检验
  if [[ ! -f "$target_file.sha256" || -L "$target_file.sha256" ]]; then
    warn "缺少对应的 .sha256 校验和文件: $target_file.sha256"
    return 1
  fi
  if ! (cd "$(dirname "$target_file")" && sha256sum -c "$(basename "$target_file.sha256")" >/dev/null 2>&1); then
    warn "SHA-256 校验和不匹配（数据包损坏或被篡改）"
    return 1
  fi
  printf '  [√] SHA-256 校验和：匹配一致\n'

  # 3. 压缩包目录穿越与安全条目检验
  if ! python3 - "$target_file" <<'PY'
import pathlib, sys, tarfile
try:
    with tarfile.open(sys.argv[1], "r:gz") as archive:
        for item in archive:
            name = item.name
            path = pathlib.PurePosixPath(name)
            if (name.startswith("/") or "\\" in name or ".." in path.parts
                    or not (item.isfile() or item.isdir())):
                sys.exit(2)
    sys.exit(0)
except Exception:
    sys.exit(3)
PY
  then
    warn "Tar 压缩包包含恶意路径穿越或非安全条目。"
    return 1
  fi
  printf '  [√] Tar 压缩包结构：安全合规（无路径穿越或软链接）\n'

  # 4. 沙箱解压并深度校验 SQLite 数据库与站点元数据
  local sandbox
  sandbox="$(mktemp -d "/tmp/.linecode-verify-dr.XXXXXX")"
  if ! tar -C "$sandbox" -xzf "$target_file" 2>/dev/null; then
    warn "解压到沙箱环境失败。"
    rm -rf -- "$sandbox"
    return 1
  fi

  local db_file="$sandbox/sites.db"
  if [[ ! -f "$db_file" ]]; then
    warn "备份包中缺少核心数据库 sites.db！"
    rm -rf -- "$sandbox"
    return 1
  fi

  local db_check
  db_check="$(python3 - "$db_file" <<'PY'
import sqlite3, sys
try:
    conn = sqlite3.connect(sys.argv[1])
    cursor = conn.cursor()
    integrity = cursor.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        print(f"integrity_failed:{integrity}")
        sys.exit(1)
    tables = set(row[0] for row in cursor.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall())
    site_count = cursor.execute("SELECT count(*) FROM sites").fetchone()[0] if "sites" in tables else -1
    has_rate_limits = "create_rate_limits" in tables
    has_admin_attempts = "admin_login_attempts" in tables
    conn.close()
    print(f"ok:{site_count}:{has_rate_limits}:{has_admin_attempts}")
except Exception as e:
    print(f"error:{e}")
    sys.exit(1)
PY
)" || db_check="failed"

  if [[ "$db_check" =~ ^ok:([0-9]+):(True|False):(True|False)$ ]]; then
    local scount="${BASH_REMATCH[1]}"
    local has_rl="${BASH_REMATCH[2]}"
    local has_adm="${BASH_REMATCH[3]}"
    printf '  [√] SQLite 数据库完整性：PRAGMA integrity_check = ok\n'
    printf '  [√] 站点记录总数：%s 个有效记录\n' "$scount"
    printf '  [√] 频控与防护表：create_rate_limits=%s, admin_login_attempts=%s\n' "$has_rl" "$has_adm"
  else
    warn "SQLite 数据库完整性检查失败：$db_check"
    rm -rf -- "$sandbox"
    return 1
  fi

  local site_dirs
  site_dirs="$(find "$sandbox" -mindepth 1 -maxdepth 1 -type d ! -name '.*' | wc -l)"
  printf '  [√] 站点数据目录数量：%s 个目录\n' "$site_dirs"
  rm -rf -- "$sandbox"
  return 0
}
verify_disaster_recovery() {
  root_only; load_config; need tar; need sha256sum; need python3
  say "========================================================="
  say " 灾备数据包完整性非破坏性校验 (Disaster Recovery Verification)"
  say " 提示：本校验在隔离临时目录中只读检验，不会停止正在运行的服务，"
  say " 亦不会修改线上数据目录，可在任意生产运行期间安全执行。"
  say "========================================================="

  shopt -s nullglob
  local -a files=("$BACKUP_DIR"/linecode-*.tar.gz)
  ((${#files[@]})) || die "备份目录 $BACKUP_DIR 中未找到备份包。"

  say "可用备份包："
  local i
  for i in "${!files[@]}"; do
    local fsize
    fsize="$(du -h "${files[$i]}" | cut -f1)"
    printf '  [%d] %s (大小: %s)\n' "$((i+1))" "$(basename "${files[$i]}")" "$fsize"
  done
  printf '  [A] 校验全部备份包\n'

  local choice
  read -r -p "请选择要校验的备份编号 [1-${#files[@]} 或 A]: " choice

  local -a targets=()
  if [[ "$choice" =~ ^[aA]$ ]]; then
    targets=("${files[@]}")
  elif [[ "$choice" =~ ^[0-9]+$ ]] && ((choice>=1 && choice<=${#files[@]})); then
    targets=("${files[$((choice-1))]}")
  else
    die "无效选择。"
  fi

  local target passed=0 failed=0
  for target in "${targets[@]}"; do
    if verify_archive_integrity "$target"; then
      printf '\033[32m  >>> 结论：灾备包 [%s] 完整健康，确认具备完整恢复能力！\033[0m\n\n' "$(basename "$target")"
      ((passed++))
    else
      printf '\033[31m  >>> 结论：灾备包 [%s] 存在异常或损坏，请排查！\033[0m\n\n' "$(basename "$target")"
      ((failed++))
    fi
  done

  say "=== 灾备校验统计 ==="
  printf '校验总数：%d | 完好合格：%d | 损坏/异常：%d\n' "${#targets[@]}" "$passed" "$failed"
  if ((failed > 0)); then
    die "检测到 $failed 个存在异常的灾备包，请核实灾备存储健康度！"
  fi
}
restore_data() {
  root_only; load_config; need tar; need sha256sum; need python3
  say '可用备份'; local files=() file selected tmp old slot failed other
  local -a restore_running=()
  shopt -s nullglob
  files=("$BACKUP_DIR"/linecode-*.tar.gz)
  ((${#files[@]})) || die '没有找到备份。'
  local i; for i in "${!files[@]}"; do printf '[%d] %s\n' "$((i+1))" "${files[$i]}"; done
  read -r -p '输入编号: ' selected
  [[ "$selected" =~ ^[0-9]+$ ]] && ((selected>=1 && selected<=${#files[@]})) || die '备份编号无效。'
  file="${files[$((selected-1))]}"

  # 在停止服务前先执行非破坏性完整性校验，防止因为备份包损坏而停服
  say "正在执行恢复前灾备包完整性预检..."
  verify_archive_integrity "$file" || die "灾备包完整性预检失败，拒绝执行恢复，线上服务保持原样。"

  confirm "即将恢复 $file；当前数据会先备份，服务短暂停止" '确认恢复' || die '已取消。'
  tmp="$(mktemp -d "$(dirname "$DATA_DIR")/.linecode-restore.XXXXXX")"
  tar -C "$tmp" -xzf "$file" || die "解包失败，临时文件保留在 $tmp。"
  backup_data
  slot="$(active_slot)"
  for other in blue green; do
    if container_running "$other"; then
      restore_running+=("$other")
      docker stop --time 30 "$(container_name "$other")" >/dev/null
    fi
  done
  old="$DATA_DIR.before-restore-$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 4)"
  if ! mv -- "$DATA_DIR" "$old"; then
    for other in "${restore_running[@]}"; do docker start "$(container_name "$other")" >/dev/null || true; done
    die '无法移动当前数据目录；旧数据保持原位。'
  fi
  if ! mv -- "$tmp" "$DATA_DIR"; then
    mv -- "$old" "$DATA_DIR"
    for other in "${restore_running[@]}"; do docker start "$(container_name "$other")" >/dev/null || true; done
    die '无法启用恢复目录；已还原旧数据目录。'
  fi
  if ! chown -R 10001:10001 "$DATA_DIR"; then
    failed="$DATA_DIR.failed-restore-$(openssl rand -hex 4)"
    mv -- "$DATA_DIR" "$failed"; mv -- "$old" "$DATA_DIR"
    for other in "${restore_running[@]}"; do docker start "$(container_name "$other")" >/dev/null || true; done
    die "恢复目录权限设置失败；原数据已还原。失败目录：$failed"
  fi
  if [[ "$slot" == blue || "$slot" == green ]]; then
    if ! docker start "$(container_name "$slot")" >/dev/null || ! health_port "$(slot_port "$slot")"; then
      docker stop --time 30 "$(container_name "$slot")" >/dev/null 2>&1 || true
      failed="$DATA_DIR.failed-restore-$(openssl rand -hex 4)"
      mv -- "$DATA_DIR" "$failed"; mv -- "$old" "$DATA_DIR"
      for other in "${restore_running[@]}"; do docker start "$(container_name "$other")" >/dev/null || warn "槽位 $other 自动重启失败。"; done
      die "恢复版本未通过健康检查，原数据已还原。失败目录：$failed"
    fi
  fi
  for other in "${restore_running[@]}"; do
    [[ "$other" == "$slot" ]] || docker start "$(container_name "$other")" >/dev/null || warn "闲置槽 $other 恢复后未能重启。"
  done
  say "恢复完成；原数据保留在 $old。"
}
health_check() {
  load_config; need docker; need curl
  local slot; slot="$(active_slot)"
  [[ "$slot" == blue || "$slot" == green ]] || die '未找到活跃槽位。'
  say "健康检查：$(container_name "$slot")"
  health_port "$(slot_port "$slot")" && printf 'HTTP /healthz：正常\n' || warn 'HTTP /healthz：失败'
  local -a tls_args=()
  if [[ "$TLS_MODE" == selfsigned ]]; then tls_args=(--insecure); warn '自签证书体检仅检查可用性，不验证证书信任链。'; fi
  curl --silent --show-error --fail --max-time 8 "${tls_args[@]}" \
    --resolve "$APP_DOMAIN:443:127.0.0.1" "https://$APP_DOMAIN/healthz" >/dev/null \
    && printf '本机 Nginx HTTPS 入口：正常\n' || warn '本机 Nginx HTTPS 入口：失败'
  curl --silent --show-error --fail --max-time 8 "${tls_args[@]}" \
    "https://$APP_DOMAIN/healthz" >/dev/null \
    && printf '域名 HTTPS 入口：正常\n' || warn '域名 HTTPS 入口：失败（检查 DNS、防火墙、证书及反向代理）'
  docker stats --no-stream "$(container_name "$slot")" || true
  printf '\n宿主机负载：'; cat /proc/loadavg
  printf 'CPU 逻辑核心：'; nproc
  uptime || true
  df -h "$DATA_DIR"; free -h || true
  docker inspect -f '状态：{{.State.Status}}；镜像：{{.Config.Image}}' "$(container_name "$slot")"
}
service_menu() {
  load_config; need docker
  local slot op name; slot="$(active_slot)"; [[ "$slot" == blue || "$slot" == green ]] || die '未找到活跃槽位。'
  name="$(container_name "$slot")"
  printf '[1] 启动 [2] 停止 [3] 重启 [4] 实时日志 [5] 容器终端 [0] 返回\n'
  read -r -p '选择: ' op
  case "$op" in
    1) docker start "$name"; health_port "$(slot_port "$slot")" || warn '启动后健康检查失败。';;
    2) confirm '停止服务' '确认停止' && docker stop --time 30 "$name";;
    3) docker restart --time 30 "$name"; health_port "$(slot_port "$slot")" || warn '重启后健康检查失败。';;
    4) docker logs --follow --tail 100 "$name";;
    5) docker exec -it "$name" sh;;
    0) return;;
    *) warn '无效选项。';;
  esac
}
init_deploy() {
  root_only; preflight
  if [[ -e "$CONFIG_FILE" || -e "$ENV_FILE" ]]; then
    load_config
    confirm '部署配置已存在，将沿用原配置重新执行部署' '确认部署' || die '已取消。'
    deploy_new
    return
  fi
  APP_DOMAIN="$(ask '应用域名（不含 https://）' 'play.linecode.top')"
  SITE_DOMAIN="$(ask '分享域名（可暂与应用相同）' "$APP_DOMAIN")"
  DATA_DIR="$(ask 'Docker 映射的宿主机本地数据目录' '/srv/linecode-html-playground/data')"
  BACKUP_DIR="$(ask '宿主机本地备份目录' '/srv/linecode-html-playground/backups')"
  local default_repo
  default_repo="$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null || echo 'https://github.com/linecode/linecode-html-playground.git')"
  GIT_REPO_URL="$(ask 'GitHub 仓库地址（支持 https/ssh）' "$default_repo")"
  GIT_BRANCH="$(ask 'Git 更新跟踪分支' 'main')"
  printf '[1] 使用已有正式证书  [2] 生成 30 天自签证书（仅测试）\n'
  local choice; read -r -p 'TLS 方式: ' choice
  case "$choice" in
    1) TLS_MODE=existing
       CERT_FILE="$(ask '证书完整链绝对路径' '/etc/letsencrypt/live/play.linecode.top/fullchain.pem')"
       KEY_FILE="$(ask '私钥绝对路径' '/etc/letsencrypt/live/play.linecode.top/privkey.pem')";;
    2) TLS_MODE=selfsigned
       CERT_FILE="$STATE_DIR/selfsigned.crt"; KEY_FILE="$STATE_DIR/selfsigned.key";;
    *) die '请选择 1 或 2。';;
  esac
  validate_config
  if [[ "$APP_DOMAIN" == "$SITE_DOMAIN" ]]; then warn '应用与分享内容共用域名；正式上线建议另配分享域名。'; fi
  say "========================================================="
  say " 确认首次部署配置："
  say "   - 应用域名:   https://$APP_DOMAIN"
  say "   - 分享域名:   https://$SITE_DOMAIN"
  say "   - 宿主数据目录: $DATA_DIR  (映射至容器 /data/sites)"
  say "   - 宿主备份目录: $BACKUP_DIR"
  say "   - GitHub 仓库: $GIT_REPO_URL (分支: $GIT_BRANCH)"
  say "========================================================="
  confirm "确认配置并开始首次构建部署" '确认首次部署' || die '已取消。'
  write_config; write_env; deploy_new
}
main() {
  case "${1:-menu}" in
    --help|-h|help)
      printf '用法：bash scripts/server-deploy.sh [init|deploy|update|security|backup|restore|verify-dr|health|service|frontend|--check]\n'
      printf '选项说明：\n'
      printf '  init       首次配置、目录映射检查与完整部署\n'
      printf '  deploy     基于当前工作区代码重新构建镜像并平滑切换\n'
      printf '  update     从 GitHub 拉取指定分支最新代码后构建热切\n'
      printf '  backup     全量数据一致性备份（生成 tar.gz 与 sha256）\n'
      printf '  verify-dr  非破坏性灾备包完整性校验（校验哈希与 SQLite）\n'
      printf '  restore    交互式容灾恢复（预检哈希、解压、数据还原）\n'
      printf '  security   系统与文件权限安全检查及加固\n'
      printf '  health     系统与容器运行健康体检\n'
      printf '  service    服务运维管理（启动/停止/重启/日志/终端）\n'
      printf '  frontend   前端重载（整体 Next.js 镜像重建与 Nginx 重载）\n'
      printf '  --check    检查脚本语法与项目完整性（只读不影响系统）\n';;
    --check) need bash; need git; [[ -f "$PROJECT_DIR/Dockerfile" && -f "$PROJECT_DIR/package.json" ]] || die '项目目录不完整。'; bash -n "${BASH_SOURCE[0]}"; say '脚本语法和项目位置检查通过；未修改服务器。';;
    init) init_deploy;; deploy) root_only; deploy_new;; update) root_only; git_update;; security) security_check;;
    backup) root_only; backup_data;; verify-dr) root_only; verify_disaster_recovery;; restore) restore_data;; health) health_check;;
    service) root_only; service_menu;;
    frontend) root_only; load_config; say '本项目是 Next.js 前后端一体容器，无独立 dist；执行整体镜像重建并热切换。'; deploy_new;;
    menu)
      while :; do
        printf '\n================== 部署与运维控制台 ==================\n'
        printf ' [1] 首次完整部署      [2] 版本更新迭代(GitHub)  [3] 系统安全检查\n'
        printf ' [4] 全量数据备份      [5] 数据容灾恢复          [6] 系统健康体检\n'
        printf ' [7] 服务运维管理      [8] 前端静态重载          [9] 灾备完整性校验\n'
        printf ' [0] 退出控制台\n'
        printf '=======================================================\n'
        local choice; read -r -p '请选择: ' choice || return 0
        case "$choice" in
          1) main init;; 2) main update;; 3) main security;; 4) main backup;;
          5) main restore;; 6) main health;; 7) main service;; 8) main frontend;;
          9) main verify-dr;; 0) return 0;; *) warn '无效选项。';;
        esac
      done;;
    *) die '用法：bash scripts/server-deploy.sh [init|deploy|update|security|backup|verify-dr|restore|health|service|frontend]' ;;
  esac
}
case "${1:-menu}" in
  --help|-h|help|--check) ;;
  *)
    root_only; need flock
    exec 9>/run/lock/linecode-html-playground-deploy.lock
    flock -n 9 || die '已有一个部署控制台正在运行，请等待其结束。'
    ;;
esac
main "${1:-menu}"
