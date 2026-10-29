# linecode-html-playground

HTML 分享站点：支持粘贴或上传 HTML、上传 ZIP，经过文件结构与 HTML 规则检查后发布；提供到期管理和后台审核。前后端由一个 Next.js 服务运行，站点元数据使用 SQLite。

## 部署

- Linux 自托管服务器：从 GitHub 检出仓库后，运行 `sudo bash scripts/server-deploy.sh`，按中文菜单首次部署或更新。操作前请阅读[服务器部署说明](docs/server-deploy.md)。
- Windows / PowerShell 自托管或工作台候选构建：参见[现有部署助手](docs/deploy-script.md)和[工作台部署说明](docs/workbench-deploy.md)。

持久化数据映射到容器内 `/data/sites`，其中 `/data/sites/sites.db` 是 SQLite 数据库。生产发布需要配置 HTTPS、Nginx 和管理员密钥。
