"use client";

import { api, type ApiResponse } from "@/lib/api";

/**
 * ═══ INSTANCE SETTINGS AND MODELS (client side, Forja Engine only) ═══════════════
 *
 * The only way components reach `/api/engine/settings` and `/api/engine/models`: no
 * component writes those paths. The routes hold the engine key server-side; this module
 * holds no secret and reads no `process.env`.
 *
 * Types mirror `@forja/contracts/media` (`ImageStrategySetting`, contract C4) and the
 * `/v2/system/models` answer (contract C3). They are copied, not imported, because the
 * web app does not depend on the contracts package; keep them in step with it.
 */
export type ImageSourceMode = "web-search" | "generate";

export interface ImageStrategySetting {
    mode: ImageSourceMode;
    /** `ui`: overridden in this modal; `env`: `IMAGES_FROM_WEB_SEARCH`. */
    source: "ui" | "env";
    envDefault: ImageSourceMode;
    /** False when no image generator can run: web search is used whatever the mode. */
    generationAvailable: boolean;
}

export interface EngineSettings {
    images: ImageStrategySetting;
}

export interface ModelProvider {
    id: string;
    kind: "llm" | "image" | "stock";
    envName: string;
    status: "enabled" | "disabled" | "misconfigured";
    adapterReady: boolean;
    models?: string[];
}

export interface RoleAssignment {
    role: string;
    model: string | null;
    fallbacks: string[];
    source: "env" | "auto";
    error?: string;
}

export interface EngineModels {
    providers: ModelProvider[];
    assignments: RoleAssignment[];
}

const SETTINGS = "/api/engine/settings";
const MODELS = "/api/engine/models";

export const engineSettingsApi = {
    get(): Promise<ApiResponse<EngineSettings>> {
        return api.get<EngineSettings>(SETTINGS);
    },
    setImageMode(mode: ImageSourceMode): Promise<ApiResponse<EngineSettings>> {
        return api.put<EngineSettings>(SETTINGS, { images: { mode } });
    },
    /** Drops the UI override: back to `IMAGES_FROM_WEB_SEARCH`. */
    resetImages(): Promise<ApiResponse<EngineSettings>> {
        return api.delete<EngineSettings>(`${SETTINGS}?reset=images`);
    },
    models(): Promise<ApiResponse<EngineModels>> {
        return api.get<EngineModels>(MODELS);
    },
};
