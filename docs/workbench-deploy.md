# 服务器工作台接入

本项目是需要 Node.js 后端的 Next.js 服务，交付类型为 `container`。GitHub Actions 只构建并推送候选镜像；生产发布在工作台人工确认。`https://serve.linecode.top` 是工作台管理入口，不能填作业务域名。

## 工作台填写表

| 字段 | 填写值 |
| --- | --- |
| 应用名称 | `linecode-html-playground`（可按工作台命名习惯调整） |
| 类型 | `container` |
| 交付来源 | GitHub Actions 候选版本；GHCR 固定摘要镜像 |
| owner/repository | `leeheav/linecode-html-playground` |
| 跟踪分支 | `main` |
| 工作流文件名 | `.github/workflows/workbench-build.yml` |
| 应用 ID | `de60514f-a192-41de-be55-f167c6a51d7c`；接入时核对是否属于目标应用 |
| 业务域名 | `play.linecode.top` 用于应用和分享站点；后续可接入独立的发布域名 |
| 正式证书 | **待选择**：`play.linecode.top` 对应的正式证书 |
| SPA 开关 | 不适用，容器应用 |
| 内部端口 | `3001`，服务监听 `0.0.0.0` |
| 健康检查路径 | `/healthz`，无需登录，成功返回 HTTP 200 |
| CPU/内存建议 | 首版 `1 vCPU / 1 GiB` 起；按上传量及扫描任务内存实测调整 |
| 环境变量 | `ADMIN_USERNAME`、`ADMIN_PASSWORD`、`ADMIN_SESSION_SECRET`、`SITE_PUBLIC_BASE_URL`、`SITE_RETENTION_DAYS=30`；`SITES_DIR=/data/sites`。浏览器可见配置不得包含秘密 |
| 命名卷 | 应用专属命名卷挂载到 `/data/sites`，读写，容器 UID/GID `10001:10001` |
| 外部服务依赖 | 无数据库或 Redis 服务；GHCR 私有镜像拉取凭据由工作台单独配置 |

这张表供人工在工作台填写；工作台不会自动读取仓库文档或 `.env.example`。目前用户只有 `play.linecode.top`，公开 HTML 由响应 CSP `sandbox` 限制为不具备同源权限，且禁止表单提交和网络连接。后续建议把分享站点迁至独立域名，进一步减少同域承载用户内容的风险。

## 构建与候选版本

1. 提交代码到 `main`，或手动运行 `workflow_dispatch`。工作台触发时可传入 `workbench_build_id`；该值原样写入 manifest，未传时为空字符串。
2. Actions 用 npm 锁文件安装依赖，执行类型检查、测试，再构建 `linux/amd64` 镜像并推送 GHCR。镜像构建在 CI，生产服务器不运行仓库构建命令。
3. Artifact 名为 `workbench-release-de60514f-a192-41de-be55-f167c6a51d7c`，根目录只有 `workbench-release.json`。其中 `image` 为 `ghcr.io/leeheav/linecode-html-playground@sha256:<真实摘要>`；工作台按摘要接收候选版本。CI 不调用生产发布接口。
4. 在工作台检查候选镜像、环境变量、域名、证书、命名卷和健康检查，再人工确认发布。若 GHCR 镜像为私有，将生产拉取凭据配置在工作台；不要使用 GitHub App 私钥充当镜像密码。

工作流中的应用 ID 已存在于仓库，但尚需在目标工作台核对；不能仅凭仓库值认定已完成接入。工作流模板如由工作台下载，以模板为准核对接入字段后再发布。

## 运行与持久化

容器用 `10001:10001` 运行，根文件系统设为只读；给 `/tmp` 可写临时空间，并将应用专属命名卷挂载到 `/data/sites`。所有站点文件和元数据都应留在该卷中，容器日志写 stdout/stderr。容器接收 `SIGTERM` 时由 Node.js 正常退出。

`ADMIN_PASSWORD` 至少 12 字符；`ADMIN_SESSION_SECRET` 使用独立的至少 32 字节随机秘密。通过工作台注入生产值，不提交 `.env`、Cookie、SSH 密钥或证书私钥。`SITE_PUBLIC_BASE_URL` 填分享站点的 HTTPS 根地址。`NEXT_PUBLIC_` 开头的值会进入浏览器构建产物；不能用它存秘密，也不能指望工作台运行时注入修改已经构建的前端代码。

生产环境必须设置 `SITE_PUBLIC_BASE_URL`；当前填写 `https://play.linecode.top`。配置不完整时健康检查返回 503。站点到期或下线后公开链接立即不可访问，文件默认在后台保留 30 天（`SITE_RETENTION_DAYS` 可设为 1-365），定时清理，并在下次创建站点前再次清理。自动检查仅做文件结构和 HTML 风险规则判断，不是病毒库扫描。ZIP 根目录必须有 `index.html`，资源应使用相对路径。

发布前备份命名卷。镜像回滚不会回滚卷中的站点数据、元数据或未来的数据库结构；涉及格式变化时先检查向前、向后兼容性。当前 `npm run migrate:sites` 仅用于把旧版本工作目录的 `public/sites/*.html` 迁移到 `SITES_DIR`，需要能同时访问旧目录与目标目录的人工环境，且应在切流前备份并单独执行；工作台不会自动执行。常规新部署不运行该迁移。

## 本地核验

有 Docker 的环境可在设置测试凭据后构建镜像，再以 `--read-only`、`--tmpfs /tmp`、专属命名卷和 `--user 10001:10001` 启动。检查 `/healthz` 返回 200、端口 3001 可达、上传文件写入命名卷，随后发送 `SIGTERM` 并查看退出日志。生产数据卷不得用于测试。
