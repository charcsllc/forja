# forja-browser sidecar: Playwright + Chromium + sharp, no Docker socket (07 §1).
# Phase 0 ships an HTTP stub (GET /healthz → 200, everything else → 501); phase 3 adds
# screenshots, axe, flows and image optimisation.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
ENV NODE_ENV=production npm_config_update_notifier=false npm_config_fund=false
WORKDIR /app
COPY package.json server.mjs ./
RUN npm install --omit=dev --no-audit && chown -R pwuser:pwuser /app
USER pwuser
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.mjs"]
