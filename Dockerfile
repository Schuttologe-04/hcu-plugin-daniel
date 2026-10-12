# The digest pins the official Node 24.21.0 / Alpine 3.24 multi-platform image.
# Packaging explicitly selects linux/arm64 and validates the resulting image.
ARG NODE_IMAGE=node:24.21.0-alpine3.24@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81

FROM ${NODE_IMAGE} AS builder
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm exec tsc -- --noEmit -p tsconfig.build.json && npm run build

FROM ${NODE_IMAGE} AS production-dependencies
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    GOE_REAL_WRITES_ENABLED=true
COPY --from=production-dependencies /build/node_modules/ ./node_modules/
COPY --from=builder /build/dist/ ./dist/
COPY package.json package-lock.json config.installed.json ./
RUN mkdir -p /data
# HCU owns the runtime mounts. Root permits /TOKEN mode 0600 and /data with an
# HCU-assigned owner; no credentials are embedded or ownership changed here.
LABEL de.eq3.hmip.plugin.metadata='{"pluginId":"com.psd.hcu.goe.loadmanagement","issuer":"PSD","version":"0.1.0","hcuMinVersion":"1.4.7","scope":"LOCAL","friendlyName":{"de":"go-e Lastmanagement"},"description":{"de":"Dynamisches Lastmanagement für lokale go-e Charger mit go-e Controller."},"logsEnabled":true}'
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/app/dist/cli/hcu-installed.js"]
CMD []
