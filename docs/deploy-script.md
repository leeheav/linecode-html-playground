# 中文交互式部署助手

在仓库根目录运行 `pwsh -File scripts/deploy.ps1`。脚本提供首次配置、代码与依赖检查、Docker 首次部署和更新、从 GitHub 拉取更新、数据卷备份、灾备包完整性校验、镜像回滚、健康检查，以及触发工作台候选构建。也可以用 `-Action Init|Check|Deploy|Update|Backup|VerifyDR|Rollback|Health|Workbench` 直接执行单项。需要 PowerShell 7；本地检查和 Docker 构建需要 Node.js 22.13+ 与 npm，Docker 模式还需要 Linux 容器 Docker Engine，工作台候选模式需要 `git` 和已登录的 `gh`。

## 首次部署与本地映射文件夹

1. **首次配置**：运行 `pwsh -File scripts/deploy.ps1 -Action Init`，交互输入 HTTPS 应用地址、分享地址、Docker 端口、容器名、**宿主机本地映射数据目录（默认推荐映射至项目根目录 `data/sites` 或专用磁盘绝对路径）**和管理员用户名。脚本生成随机管理员密码和会话密钥，写入本机 `.env.production.local`；密码只显示一次，请立即保存到密码管理器。`.deployment.local.json` 保存数据映射和其他非秘密配置。两个文件均被 Git 忽略。Windows 上脚本尝试把密钥文件 ACL 收紧到当前用户和 SYSTEM。
2. **代码与安全检查**：运行 `pwsh -File scripts/deploy.ps1 -Action Check`。脚本执行类型检查、Lint、集成测试、Next 生产构建，以及官方 npm registry 的生产依赖审计。高危及以上漏洞会阻止部署。
3. **自托管 Docker 部署**：运行 `pwsh -File scripts/deploy.ps1 -Action Deploy`。脚本构建 Linux amd64 前后端一体镜像，确保宿主机本地映射文件夹具有正确读写权限，以 UID/GID 10001、只读根文件系统、可写 `/tmp` 启动容器，配置 SQLite 路径 `/data/sites/sites.db`，核查 `/healthz`。容器端口仅绑定 `127.0.0.1:3001`（或配置端口）。
4. **从 GitHub 更新并热切部署**：运行 `pwsh -File scripts/deploy.ps1 -Action Update`（菜单 `9`）。脚本自动检查当前分支，从 GitHub 远程仓库快进拉取最新代码，随后执行镜像重新构建与健康热切。
5. **灾备包完整性校验**：运行 `pwsh -File scripts/deploy.ps1 -Action VerifyDR`（菜单 `8`）。对备份目录下的灾备包执行非破坏性体检，校验 SHA-256 哈希值、安全目录结构与文件完整性，无需停服。
6. **工作台**：代码提交并推送至远程 `main` 后，运行 `pwsh -File scripts/deploy.ps1 -Action Workbench`。按工作台指导完成候选构建与清单校验。

## 控制台菜单选项

```text
1 首次配置  2 检查代码与安全  3 Docker 首次部署/更新  4 备份数据卷
5 回滚镜像  6 健康检查  7 触发工作台候选构建  8 灾备完整性校验
9 从 GitHub 拉取更新  0 退出
```

## Docker 数据目录本地映射

脚本强制使用宿主机绝对路径映射（`--mount type=bind,source=$HostDataPath,target=/data/sites`），确保容器在停止、销毁或切换历史镜像时，SQLite 数据库（`sites.db`）和全部站点静态文件完整保留在宿主机磁盘中，达成企业级持久化要求。
