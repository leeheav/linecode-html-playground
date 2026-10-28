# 适配当前 linecode-html-playground：工作台固定 UID/GID 10001、只读根和 /data/sites 卷。
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
# 当前项目 React 19/date-fns 4 与 react-day-picker 8 的 peer 范围冲突。
# 与生成锁文件时使用同一模式；这不等于已完成依赖兼容性或漏洞治理。
RUN npm ci --legacy-peer-deps --no-audit --no-fund \
    --registry=https://registry.npmjs.org/ \
    --fetch-retries=3 \
    --fetch-retry-mintimeout=10000 \
    --fetch-retry-maxtimeout=60000 \
    --fetch-timeout=120000
# 2026-10-14 官方修复线：阻止把当前旧 15.2.4 直接构建上线。
# 这是最低版本门槛，不代替发布时核对最新公告及 npm audit。
RUN node -e "const v=require('next/package.json').version;const [a,b,c]=v.split('.').map(Number);if(!/^\d+\.\d+\.\d+$/.test(v)||!((a===15&&(b>5||(b===5&&c>=28)))||(a===16&&(b>4||(b===4&&c>=1)))||a>16))throw new Error('Upgrade Next.js before deployment; installed: '+v)"

FROM dependencies AS builder
ARG NEXT_PUBLIC_BASE_URL=https://play.linecode.top
ENV NEXT_PUBLIC_BASE_URL=${NEXT_PUBLIC_BASE_URL}
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3001 \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    SITES_DIR=/data/sites
RUN groupadd --gid 10001 nextjs \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin nextjs \
    && mkdir -p /data/sites \
    && chown 10001:10001 /data/sites
COPY --from=builder --chown=10001:10001 /app/.next/standalone ./
COPY --from=builder --chown=10001:10001 /app/.next/static ./.next/static
COPY --from=builder --chown=10001:10001 /app/public ./public
# 每个候选容器使用自己的临时缓存，不与其他版本共享 Next.js 缓存。
RUN rm -rf /app/.next/cache \
    && ln -s /tmp/next-cache /app/.next/cache
USER 10001:10001
EXPOSE 3001
STOPSIGNAL SIGTERM
CMD ["sh", "-c", "mkdir -p /tmp/next-cache && exec node server.js"]
