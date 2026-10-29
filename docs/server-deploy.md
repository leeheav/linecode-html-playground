# Linux 服务器交互式部署

本项目是一个 Next.js 前后端一体服务，站点元数据使用 SQLite，上传文件和数据库都保存在持久化目录。仓库没有独立的 MySQL 服务、前端 `dist` 包或独立前端容器。服务器控制台位于 [`scripts/server-deploy.sh`](../scripts/server-deploy.sh)，面向将代码从 GitHub 检出到 Linux amd64 服务器后，在该服务器上构建并运行 Docker 镜像的场景。

## 准备服务器

1. 安装 Git、Docker Engine（Linux 容器）、Bash、Nginx、OpenSSL、curl、tar、sha256sum、Python 3、systemd 和基础系统工具。脚本配置 `/etc` 下的 Nginx 与本机密钥，因此需要 `sudo` 或 root。服务器须能访问 GitHub、基础镜像仓库和 npm registry。
2. 为应用域名配置 DNS。正式环境使用覆盖应用域名和分享域名的可信 HTTPS 证书；脚本的 30 天自签证书仅适合临时测试，浏览器会提示不受信任。将 Nginx 的 80/443 端口对外开放，应用容器端口只绑定本机回环地址。现有 Nginx 配置须通过 `nginx -t`。
3. 在服务器上检出仓库，并进入项目目录：

   ```bash
   git clone <你的仓库地址> linecode-html-playground
   cd linecode-html-playground
   sudo bash scripts/server-deploy.sh
   ```

4. 首次部署按中文菜单选择 `1`，逐项输入应用域名、分享域名、宿主机数据与备份目录、Git 更新分支和证书路径。输入完整确认词后，脚本生成管理员初始密码并显示一次；请立即保管。配置保存在 `/etc/linecode-html-playground/deploy.conf`，密钥保存在 `/etc/linecode-html-playground/app.env`，均为 root 私有文件。备份位于交互指定的宿主机目录。这些文件不要提交到 Git。

部署账号对宿主机站点数据目录应有管理权限；容器以 UID/GID `10001:10001` 运行，须能写入映射后的 `/data/sites`。SQLite 文件在 `/data/sites/sites.db`，站点文件也在该目录。数据目录应位于 Git 仓库之外的持久化磁盘上，更换目录前先备份并迁移数据。

## 控制台菜单

```text
[1] 首次完整部署
[2] 版本更新迭代
[3] 系统安全检查
[4] 全量数据备份
[5] 数据容灾恢复
[6] 系统健康体检
[7] 服务运维管理
[8] 前端静态重载
[0] 退出控制台
```

也可以直接运行 `sudo bash scripts/server-deploy.sh init|deploy|update|security|backup|restore|health|service|frontend`，用 `bash scripts/server-deploy.sh --check` 仅检查脚本语法及项目位置。`deploy` 使用本机当前代码重新构建，`update` 先从 GitHub 快进拉取。脚本通过 Nginx 代理 Docker 中的 Next.js 服务；Next.js 镜像同时包含前端页面和后端接口。

| 菜单 | 实际操作 |
| --- | --- |
| `1` 首次完整部署 | 配置本机密钥与数据映射，检查 Docker/Nginx 及目录权限，构建镜像、启动服务并检查 `/healthz`。证书选择按提示操作。 |
| `2` 版本更新迭代 | 拒绝有未提交改动或分支不符的工作树，从 `origin` 快进拉取指定分支；更新前备份、审计依赖、构建候选镜像、执行幂等 SQLite 迁移并探活，再切换 Nginx 代理端口。 |
| `3` 系统安全检查 | 显示密钥和目录权限、证书有效期、管理员密码长度、容器端口及只读根配置；执行生产依赖审计，可按提示收紧文件和目录权限。 |
| `4` 全量数据备份 | 为保证 SQLite 与附件一致，短暂停止当前服务后打包持久化目录并生成 SHA-256 校验文件，随后恢复服务。保留按文件名排序最新的 14 份备份，旧备份及校验文件会被删除。 |
| `5` 数据容灾恢复 | 列出可用备份，校验 SHA-256 与压缩包路径，确认目标后恢复 SQLite 与上传文件，再启动服务并验证健康状态。原数据目录会暂留在旁边。 |
| `6` 系统健康体检 | 查看 HTTP 探活、容器状态和宿主机 CPU、内存、磁盘等信息。 |
| `7` 服务运维管理 | 交互执行容器启停、日志查看或进入容器。 |
| `8` 前端静态重载 | 使用当前服务器代码重新构建并切换整个 Next.js 镜像，随后重载 Nginx；项目没有可单独替换的 `dist`。 |

更新会使用 Git 的快进拉取；服务器上存在未提交修改或分叉历史时，应先处理仓库状态，不能靠部署脚本覆盖。新版本经候选健康检查后才切换 Nginx 流量；旧容器随后停止，镜像与容器保留。候选与旧容器短时间共享 SQLite 及附件目录，新旧代码的数据格式必须兼容；脚本不会自动回滚数据库。更新前备份、手动备份和恢复会产生短暂停机，不能将其视为全程零停机。恢复前脚本会先备份当前目录，成功后将原目录保留为 `*.before-restore-*`；执行前仍须核对磁盘空间。

## HTTPS、隔离和安全门槛

应用地址与分享站点地址都必须使用 HTTPS。当前可以暂用 `https://play.linecode.top`，但将用户上传的 HTML 放在独立分享域名更安全。容器公开端口只在 `127.0.0.1` 上监听；Nginx 是唯一对外入口。正式部署时确认 DNS、证书、反向代理和防火墙设置一致。自签证书没有自动续期，正式证书也需在外部维护续期。菜单 `3` 的一键加固只调整本机密钥和数据目录权限，不会改防火墙或其他 Nginx 站点。不要把 `.env.production.local`、证书私钥、备份或管理员密码推送到 GitHub。

菜单 `1`、`2`、`8` 会在 Docker 中对锁文件执行官方 npm 生产依赖审计；遇到高危或严重告警时必须输入完整风险确认词才会继续，审计服务不可用则停止部署。镜像构建还会执行 Dockerfile 中的 Next.js 最低版本检查和生产构建，并运行幂等 SQLite 历史元数据迁移。类型检查、Lint 和集成测试仍应在提交前或 CI 中运行：`npm ci --legacy-peer-deps`、`npm run typecheck`、`npm run lint`、`npm test`。当前依赖锁文件可能触发 Next.js 内嵌 PostCSS 的高危告警，应先修复并重新验证。上传内容的结构和 HTML 规则扫描也不能代替病毒扫描或沙箱分析。

## 与工作台部署的关系

这个 Linux 脚本用于自行管理的服务器，不会替代工作台的发布流程。工作台候选镜像仍按 [`docs/workbench-deploy.md`](workbench-deploy.md) 构建并由人工确认生产发布；工作台的数据卷和本服务器的宿主机目录是两套独立存储，不能仅通过切换镜像迁移数据。
