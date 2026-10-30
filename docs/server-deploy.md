# Linux 服务器交互式部署

本项目是一个 Next.js 前后端一体服务，站点元数据使用 SQLite，上传文件和数据库都保存在宿主机持久化目录。仓库没有独立的 MySQL 服务、前端 `dist` 包或独立前端容器。服务器控制台位于 [`scripts/server-deploy.sh`](../scripts/server-deploy.sh)，面向将代码从 GitHub 检出到 Linux amd64 服务器后，在该服务器上构建并运行 Docker 镜像的场景。

## 准备服务器与本地映射目录

1. **基础工具**：安装 Git、Docker Engine（Linux 容器）、Bash、Nginx、OpenSSL、curl、tar、sha256sum、Python 3、systemd 和基础系统工具。脚本配置 `/etc` 下的 Nginx 与本机密钥，因此需要 `sudo` 或 root。服务器须能访问 GitHub、基础镜像仓库和 npm registry。
2. **DNS 与证书**：为应用域名配置 DNS。正式环境使用覆盖应用域名和分享域名的可信 HTTPS 证书；脚本的 30 天自签证书仅适合临时测试，浏览器会提示不受信任。将 Nginx 的 80/443 端口对外开放，应用容器端口只绑定本机回环地址（127.0.0.1:3001/3002）。现有 Nginx 配置须通过 `nginx -t`。
3. **从 GitHub 检出代码**：在服务器上检出仓库，并进入项目目录：

   ```bash
   git clone <你的 GitHub 仓库地址> linecode-html-playground
   cd linecode-html-playground
   sudo bash scripts/server-deploy.sh
   ```

4. **宿主机本地映射文件夹（Host Directory Mapping）**：
   - 部署必须使用**宿主机本地映射目录**（默认为 `/srv/linecode-html-playground/data`），映射至容器内 `/data/sites`。
   - 持久化内容包括：SQLite 数据库文件（`$DATA_DIR/sites.db`）以及所有用户上传的静态文件及元数据（`$DATA_DIR/<site-name>/*`）。
   - 容器以 UID/GID `10001:10001` 运行，脚本会在部署前自动测试写入权限。即使容器被销毁、升级或重建，数据始终完好保存在宿主机本地目录中。
   - 宿主机备份目录独立保存在外部持久化磁盘（如 `/srv/linecode-html-playground/backups`）。
5. **初始化配置**：首次部署按中文菜单选择 `1`，输入应用域名、分享域名、宿主机本地映射数据目录、备份目录、GitHub 仓库地址（支持 HTTPS/SSH）以及 Git 跟踪分支。配置保存在 `/etc/linecode-html-playground/deploy.conf`，密钥保存在 `/etc/linecode-html-playground/app.env`，均为 root 权限私有文件（600/700）。

## 控制台菜单与命令

```text
================== 部署与运维控制台 ==================
 [1] 首次完整部署      [2] 版本更新迭代(GitHub)  [3] 系统安全检查
 [4] 全量数据备份      [5] 数据容灾恢复          [6] 系统健康体检
 [7] 服务运维管理      [8] 前端静态重载          [9] 灾备完整性校验
 [0] 退出控制台
=======================================================
```

可以直接运行命令行非交互指令：
`sudo bash scripts/server-deploy.sh [init|deploy|update|security|backup|verify-dr|restore|health|service|frontend|--check]`

| 菜单 / 命令 | 实际操作 |
| --- | --- |
| `1` 首次完整部署 (`init`) | 交互配置域名、GitHub 仓库、宿主机本地映射目录与证书，验证 Docker/Nginx，构建一体镜像并热切上线。 |
| `2` 版本更新迭代 (`update`) | 自动与 GitHub 远程仓库同步，从目标分支快进拉取（`git fetch` + `git merge --ff-only`）；执行热切前备份、依赖审计、新镜像构建、SQLite 历史迁移与探活切换。 |
| `3` 系统安全检查 (`security`) | 检查配置与数据目录权限、证书有效期、管理员密码强度、容器端口回环绑定；一键收紧权限至标准推荐值。 |
| `4` 全量数据备份 (`backup`) | 为保证 SQLite 与附件强一致性，短暂停止容器后打包本地映射目录为 `tar.gz` 并计算 SHA-256 校验和文件，随后恢复服务。自动轮转保留最新 14 份。 |
| `5` 数据容灾恢复 (`restore`) | 还原指定备份。**恢复前自动调用灾备完整性预检**，确保备份包未损坏且哈希无误后才执行停服与还原，原数据安全备份为 `*.before-restore-*`。 |
| `6` 系统健康体检 (`health`) | HTTP `/healthz` 探活、Nginx 代理检查、容器资源占用、宿主机 CPU/内存/磁盘监控。 |
| `7` 服务运维管理 (`service`) | 容器启动、停止、平滑重启、实时日志查看及进入容器内部调试。 |
| `8` 前端静态重载 (`frontend`) | 本项目是 Next.js 前后端一体镜像（无独立前端 dist）；使用当前服务器代码整体重建并热切。 |
| `9` 灾备完整性校验 (`verify-dr`) | **非破坏性灾备包健康度体检**。完全不中断线上服务，在隔离沙箱中只读解压，验证 SHA-256 校验和、Tar 安全结构（防路径穿越）、SQLite 数据库完整性（`PRAGMA integrity_check`）及站点元数据。 |
| `--check` | 仅检查脚本语法与项目完整性，不修改服务器任何状态。 |

## 灾备校验与容灾保障体系

- **非破坏性验证（`verify-dr`）**：随时可在生产运行期间执行，无需停服，不修改 `$DATA_DIR`。校验项目包括：
  1. 备份文件属性与防软链接劫持检测；
  2. SHA-256 校验和文件精确匹配；
  3. 压缩包目录穿越与非法文件类型筛查；
  4. 沙箱环境中 SQLite 数据库文件头检测与 `PRAGMA integrity_check`；
  5. 核心业务表（`sites`、`create_rate_limits`、`admin_login_attempts`）与记录数量核对；
  6. 站点文件与目录样本结构扫描。
- **恢复前安全防护**：在执行 `restore` 时，脚本先对目标备份包执行上述全套完整性检验。若备份包存在损坏，立刻终止恢复流程，线上现有服务不会受到任何影响。

## HTTPS、隔离和安全门槛

- 应用地址与分享站点地址都必须使用 HTTPS。容器公开端口只在 `127.0.0.1` 上监听；Nginx 是唯一对外入口。
- 镜像构建与更新前会在 Docker 中执行官方 npm 依赖审计，阻断高危漏洞。
- 进程内对频繁创建和管理员登录失败提供了 SQLite 持久化频控与锁定机制（1 小时 10 次创建、5 次登录失败临时锁定 15 分钟），即使多实例或容器重启防刷限制依然生效。
