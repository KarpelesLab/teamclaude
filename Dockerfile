# syntax=docker/dockerfile:1

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-alpine

ARG VERSION=dev
ARG VCS_REF=unknown
ARG BUILD_DATE
LABEL org.opencontainers.image.title="teamclaude" \
      org.opencontainers.image.description="Multi-account Claude proxy with automatic quota-based rotation" \
      org.opencontainers.image.source="https://github.com/KarpelesLab/teamclaude" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}"

RUN apk add --no-cache tini su-exec

ENV NODE_ENV=production \
    TEAMCLAUDE_DISABLE_AUTOUPDATE=1 \
    TEAMCLAUDE_CONFIG=/data/teamclaude.json \
    TEAMCLAUDE_HOST=0.0.0.0

WORKDIR /app

COPY --chown=root:root package.json LICENSE ./
COPY --chown=root:root --chmod=755 src/ ./src/

RUN ln -s /app/src/index.js /usr/local/bin/teamclaude

COPY --chown=root:root --chmod=755 docker-entrypoint.sh /usr/local/bin/

RUN mkdir -p /data && chown node:node /data

WORKDIR /data

EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "const c=process.env.TEAMCLAUDE_CONFIG||'/data/teamclaude.json';let p=3456;try{p=require(c).proxy?.port||p}catch{};fetch('http://127.0.0.1:'+p+'/teamclaude/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh", "teamclaude"]
CMD ["server", "--headless"]
