# devtrends.site 的自建镜像：一个容器同时承担静态站与动态详情页。
#
# 为什么是一个容器而不是 nginx + node 两个：本站量级极小（真人约 30 会话/天，峰值小时只占
# 出网上限的 2%），Node 直接吐静态文件完全够用，少一个组件就少一处会坏的地方；等真需要
# nginx 的静态性能或更细的限流，再拆也不迟（deploy/server.mjs 已经把静态与动态分开了）。
#
# 构建阶段不需要数据库：dist/ 全部来自仓库里已提交的日报、快照与清单。
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    TZ=Asia/Shanghai
COPY --from=build /app ./
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
CMD ["node", "deploy/server.mjs"]
