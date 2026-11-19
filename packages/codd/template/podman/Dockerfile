# 备份、恢复、演练工具镜像: 以 MongoDB 镜像为底 (自带 mongodump, mongorestore, mongosh 及其全部依赖库),
# 再把 Bun 二进制从官方 Bun 镜像拷进来运行 TypeScript。
# 镜像坐标全部由 podman-compose.yml 从 .env 传入, 本文件不硬编码版本号。
ARG BUN_IMAGE=oven/bun:1.4.5-slim
ARG MONGO_IMAGE=mongo:latest

FROM ${BUN_IMAGE} AS bun

FROM ${MONGO_IMAGE}
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
# mongo 镜像默认入口会启动 mongod, 这里清空, 由 compose 或 podman run 指定命令
ENTRYPOINT []

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --production --frozen-lockfile
COPY backup.ts drill.ts lib.ts restore.ts ./
