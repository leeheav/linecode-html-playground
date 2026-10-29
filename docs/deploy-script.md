# 中文交互式部署助手

在仓库根目录运行 `pwsh -File scripts/deploy.ps1`。脚本提供首次配置、代码与依赖检查、Docker 首次部署和更新、数据卷备份、镜像回滚、健康检查，以及触发工作台候选构建。也可以用 `-Action Init|Check|Deploy|Backup|Rollback|Health|Workbench` 直接执行单项。需要 PowerShell 7；本地检查和 Docker 构建需要 Node.js 22.13+ 与 npm，Docker 模式还需要 Linux 容器 Docker Engine，工作台候选模式需要 `git` 和已登录的 `gh`。

## 首次部署

1. 运行 `pwsh -File scripts/deploy.ps1 -Action Init`，交互输入 HTTPS 应用地址、分享地址、Docker 端口、容器名、数据卷名、**宿主机数据目录绝对路径**和管理员用户名。宿主机目录留空则使用命名卷。脚本生成随机管理员密码和会话密钥，写入本机 `.env.production.local`；密码只显示一次，请立即保存到密码管理器。`.deployment.local.json` 保存数据映射和其他非秘密配置。两个文件均被 Git 忽略。Windows 上脚本尝试把密钥文件 ACL 收紧到当前用户和 SYSTEM。
2. 运行 `pwsh -File scripts/deploy.ps1 -Action Check`。脚本执行类型检查、Lint、集成测试、Next 生产构建，以及官方 npm registry 的生产依赖审计。高危及以上漏洞会阻止部署。当前锁文件的 Next 内嵌 PostCSS 存在已知高危告警，需先升级修复；如已完成风险评估，可显式加 `-AllowAuditRisk` 继续。审计服务不可用时仍会阻止部署。
3. 自托管 Docker：运行 `pwsh -File scripts/deploy.ps1 -Action Deploy`。脚本构建 Linux amd64 前后端一体镜像，创建所选的命名卷或宿主机目录，以 UID/GID 10001、只读根文件系统、可写 `/tmp` 启动容器，配置 SQLite 路径 `/data/sites/sites.db`，核查 `/healthz`。监听地址仅为 `127.0.0.1:3001`（或配置端口）；外部 HTTPS 证书和反向代理需另行配置。
4. 工作台：代码提交并推送至远程 `main` 后，运行 `pwsh -File scripts/deploy.ps1 -Action Workbench`。工作台已提供 `workbench_build_id` 时按提示输入；手动构建可留空，脚本不会自行编造该 ID。脚本触发 `.github/workflows/workbench-build.yml`、等待构建结束、下载 `workbench-release.json` 到 `.deployment-artifacts/` 并核对提交、构建 ID 与镜像摘要。随后在工作台核对该摘要、环境变量、正式证书、命名卷、端口和健康检查，并人工确认生产发布。工作台没有在本仓库提供可验证的生产发布 API，因此脚本不会假装自动完成该步骤。具体字段见 [工作台接入表](workbench-deploy.md)。

如已评估并接受当前依赖高危告警，可以在手动候选构建或 Docker 部署时显式使用 `-AllowAuditRisk`；GitHub Actions 会将跳过审计门槛标记为警告。自动推送触发的构建始终执行严格审计，失败时不会推送候选镜像。

## 更新、迁移和回滚

再次运行 `-Action Deploy` 即更新自托管 Docker：先检查代码和依赖、构建新镜像，停止旧容器并备份数据卷，使用新镜像运行幂等的 `scripts/migrate-site-db.mjs` 导入旧版 `site.json` 元数据，再启动新容器并检查健康状态。启动失败时自动恢复旧镜像；**数据库和数据卷不会自动倒退**。该迁移只针对自托管路径；工作台上的历史卷应先备份，然后按工作台文档单独执行迁移，不能假定上传新镜像会自动迁移。

`-Action Backup` 会短暂停止当前自托管容器，创建压缩备份到 `.deployment-backups/` 后恢复服务。备份使用只读挂载，避免在 SQLite 写入过程中拷贝不一致的文件。`-Action Rollback` 列出本机历史镜像，输入目标标签并确认后备份当前卷、切换镜像；数据库格式的向后兼容性须在操作前核对。备份文件含用户上传内容和管理员相关数据，应限制访问并安排异地副本。脚本不会自动删除旧镜像或备份。

## 配置和边界

### Docker 数据目录映射

首次配置时可填写宿主机的绝对路径，例如 Linux `/srv/linecode-html-playground/sites` 或 Windows Docker Desktop `F:\DockerData\linecode-html-playground`。脚本使用 Docker `--mount type=bind` 将该目录映射到容器内 `/data/sites`；SQLite 位于宿主机目录的 `sites.db`，上传站点位于同一目录下的站点子目录。目录需允许容器 UID/GID `10001:10001` 读写，脚本在部署前检查权限。建议使用仓库外的专用目录。

| 宿主机或 Docker 存储 | 容器内路径 | 内容 |
| --- | --- | --- |
| 配置的宿主机目录；留空时为命名卷 `linecode-html-playground-data` | `/data/sites` | 上传文件和站点元数据 |
| 同一目录下 `sites.db` | `/data/sites/sites.db` | SQLite 数据库 |

旧 `.deployment.local.json` 没有 `HostDataPath` 时继续使用原命名卷。更换存储方式或目录前，先备份并手工迁移原数据；仅修改路径不会复制文件。工作台模式仍使用工作台提供的专属命名卷挂载到 `/data/sites`，不使用本机宿主机目录。

容器运行环境使用 `ADMIN_USERNAME`、`ADMIN_PASSWORD`、`ADMIN_SESSION_SECRET`、`SITES_DIR=/data/sites`、`SITE_DB_PATH=/data/sites/sites.db`、`SITE_RETENTION_DAYS`、`SITE_PUBLIC_BASE_URL`、`NEXT_PUBLIC_BASE_URL`。前端构建值通过 Docker build arg 设置，改域名后必须重新构建。工作台环境变量要手工配置，不能上传 `.env.production.local`。目前应用和分享站点都可用 `https://play.linecode.top`，但建议尽快准备独立的分享域名。

脚本不会自动配置域名解析、证书、反向代理、工作台的权限或生产数据库卷。它不会把本机源代码和密钥上传到工作台；工作台候选构建仅使用已经推送的 `main`。安全检查包含静态检查、集成测试、构建和 npm 依赖审计，但不能代替恶意文件沙箱或专业漏洞扫描。
