"use client";

import { useEffect, useState } from "react";

/**
 * ═══ WHICH BACKEND, AND WHAT ITS PUBLIC URLS LOOK LIKE (client side) ═══════════
 *
 * `/api/config` says whether the builder talks to the self-hosted Forja Engine or to
 * Totalum, and how published apps are addressed (`publishScheme://<id>.publishDomain`).
 * It is fetched ONCE per page load and shared through a module-level cache, so every
 * component that asks gets the same answer without a request of its own.
 *
 * ⚠️ UNTIL IT ANSWERS (or if it fails) THE VALUES ARE TOTALUM'S. That keeps the
 * Totalum edition byte-identical to what it did before this hook existed: `https://`
 * and `totalum-project.com`, exactly the literals it replaced.
 *
 * Long-lived closures (the deploy poll) must call `readBackendConfig()` at the moment
 * they need the value rather than capturing the hook's render-time state.
 */
export interface BackendConfig {
    backend: "engine" | "totalum";
    publishScheme: "http" | "https";
    publishDomain: string;
    previewDomain: string | null;
}

export const TOTALUM_BACKEND_CONFIG: BackendConfig = {
    backend: "totalum",
    publishScheme: "https",
    publishDomain: "totalum-project.com",
    previewDomain: null,
};

let cached: BackendConfig | null = null;
let inflight: Promise<BackendConfig> | null = null;

function normalise(raw: Partial<BackendConfig> | null | undefined): BackendConfig {
    if (!raw) return TOTALUM_BACKEND_CONFIG;
    return {
        backend: raw.backend === "engine" ? "engine" : "totalum",
        publishScheme: raw.publishScheme === "http" ? "http" : "https",
        publishDomain:
            typeof raw.publishDomain === "string" && raw.publishDomain
                ? raw.publishDomain
                : TOTALUM_BACKEND_CONFIG.publishDomain,
        previewDomain: typeof raw.previewDomain === "string" && raw.previewDomain ? raw.previewDomain : null,
    };
}

export function loadBackendConfig(): Promise<BackendConfig> {
    if (cached) return Promise.resolve(cached);
    if (!inflight) {
        inflight = fetch("/api/config", { cache: "no-store" })
            .then((res) => res.json())
            .then((json: { ok?: boolean; data?: Partial<BackendConfig> }) => {
                // Only a real answer is remembered; a failure is re-asked by the next caller.
                if (json?.ok && json.data) cached = normalise(json.data);
                return cached ?? TOTALUM_BACKEND_CONFIG;
            })
            .catch(() => TOTALUM_BACKEND_CONFIG)
            .finally(() => {
                inflight = null;
            });
    }
    return inflight;
}

/** The last known answer, or Totalum's defaults if `/api/config` has not answered yet. */
export function readBackendConfig(): BackendConfig {
    return cached ?? TOTALUM_BACKEND_CONFIG;
}

/** `https://my-app.totalum-project.com` or `http://my-app.apps.forja.localhost`. */
export function publishedUrl(host: string, config: BackendConfig = readBackendConfig()): string {
    return `${config.publishScheme}://${host}`;
}

export function useBackendConfig(): BackendConfig {
    const [config, setConfig] = useState<BackendConfig>(readBackendConfig);
    useEffect(() => {
        let alive = true;
        void loadBackendConfig().then((value) => {
            if (alive) setConfig(value);
        });
        return () => {
            alive = false;
        };
    }, []);
    return config;
}
