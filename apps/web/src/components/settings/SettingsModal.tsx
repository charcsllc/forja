"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Info, RotateCcw } from "lucide-react";

import { Modal, Spinner } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/i18n";
import {
    engineSettingsApi,
    type EngineModels,
    type EngineSettings,
    type ImageSourceMode,
    type ModelProvider,
} from "@/lib/engine-settings";

/**
 * ═══ SETTINGS (Forja Engine only) ════════════════════════════════════════════════
 *
 * Instance-wide choices, not a project errand, so it is not in the workspace's
 * `openModal` union: `SettingsButton` owns it and it looks the same from home and from
 * a project.
 *
 * Images: one switch, "search images on the web", backed by `images.mode` on the engine.
 * The value shown is always the engine's answer (never an optimistic guess), with where
 * it comes from ("Set here" or the .env value) and "Reset to .env" when overridden.
 * Mode `generate` with no runnable generator says so: the web is used anyway.
 *
 * Models: read-only view of `/v2/system/models`. An engine without that endpoint (404,
 * 501) or any failure shows "Model list unavailable"; it never blocks the Images section.
 */
type Load<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "error" };

export interface SettingsModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function SettingsModal({ open, onOpenChange }: SettingsModalProps) {
    const t = useT();
    const ids = useId();
    const [settings, setSettings] = useState<Load<EngineSettings>>({ state: "loading" });
    const [models, setModels] = useState<Load<EngineModels>>({ state: "loading" });
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    // Answers to an older load (closed and reopened quickly) must not overwrite newer ones.
    const generation = useRef(0);

    const load = useCallback(async () => {
        const mine = ++generation.current;
        setSettings({ state: "loading" });
        setModels({ state: "loading" });
        setSaveError(null);
        const [s, m] = await Promise.all([engineSettingsApi.get(), engineSettingsApi.models()]);
        if (mine !== generation.current) return;
        setSettings(s.ok && s.data ? { state: "ready", value: s.data } : { state: "error" });
        setModels(m.ok && m.data ? { state: "ready", value: m.data } : { state: "error" });
    }, []);

    useEffect(() => {
        if (open) void load();
        return () => {
            generation.current++;
        };
    }, [open, load]);

    const apply = async (call: () => ReturnType<typeof engineSettingsApi.get>) => {
        setSaving(true);
        setSaveError(null);
        const res = await call();
        setSaving(false);
        if (res.ok && res.data) setSettings({ state: "ready", value: res.data });
        else setSaveError(t("engineSettings.images.saveFailed"));
    };

    const setMode = (mode: ImageSourceMode) => apply(() => engineSettingsApi.setImageMode(mode));
    const reset = () => apply(() => engineSettingsApi.resetImages());

    const switchId = `${ids}-images-web`;
    const hintId = `${ids}-images-hint`;

    return (
        <Modal open={open} onOpenChange={onOpenChange} title={t("engineSettings.title")} description={t("engineSettings.description")} size="md">
            <div className="space-y-6">
                {/* ── Images ── */}
                <section aria-labelledby={`${ids}-images`} className="space-y-3">
                    <h3 id={`${ids}-images`} className="text-sm font-semibold text-ink">
                        {t("engineSettings.images.title")}
                    </h3>

                    {settings.state === "loading" && <Spinner size="sm" label={t("common.loading")} />}

                    {settings.state === "error" && (
                        <div role="alert" className="bb-hairline space-y-2 rounded-xl bg-surface-2 p-3 text-sm">
                            <p className="font-medium text-ink">{t("engineSettings.loadFailed")}</p>
                            <p className="text-xs text-ink-3">{t("engineSettings.loadFailedDescription")}</p>
                            <Button variant="outline" size="sm" onClick={() => void load()}>
                                {t("engineSettings.retry")}
                            </Button>
                        </div>
                    )}

                    {settings.state === "ready" && (() => {
                        const images = settings.value.images;
                        const envValue = t(images.envDefault === "web-search" ? "engineSettings.images.on" : "engineSettings.images.off");
                        return (
                            <div className="bb-hairline space-y-3 rounded-xl bg-surface-2 p-3">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0">
                                        <Label htmlFor={switchId} className="text-sm">
                                            {t("engineSettings.images.switchLabel")}
                                        </Label>
                                        <p id={hintId} className="mt-0.5 text-xs text-ink-3">
                                            {t("engineSettings.images.switchHint")}
                                        </p>
                                    </div>
                                    <Switch
                                        id={switchId}
                                        aria-describedby={hintId}
                                        checked={images.mode === "web-search"}
                                        onCheckedChange={(on) => void setMode(on ? "web-search" : "generate")}
                                        disabled={saving}
                                    />
                                </div>

                                <div className="flex min-h-8 flex-wrap items-center gap-2">
                                    <Pill tone={images.source === "ui" ? "brand" : "neutral"}>
                                        {images.source === "ui"
                                            ? t("engineSettings.images.sourceUi")
                                            : t("engineSettings.images.sourceEnv", { value: envValue })}
                                    </Pill>
                                    {images.source === "ui" && (
                                        <Button variant="ghost" size="sm" onClick={() => void reset()} disabled={saving}>
                                            <RotateCcw className="size-3.5" />
                                            {t("engineSettings.images.reset")}
                                        </Button>
                                    )}
                                    {saving && <Spinner size="xs" />}
                                </div>

                                {images.mode === "generate" && !images.generationAvailable && (
                                    <p role="note" className="flex items-start gap-2 rounded-lg bg-brand-soft px-2.5 py-2 text-xs text-ink-2">
                                        <Info className="mt-px size-3.5 shrink-0" aria-hidden />
                                        {t("engineSettings.images.noGenerator")}
                                    </p>
                                )}

                                {saveError && (
                                    <p role="alert" className="text-xs text-destructive">
                                        {saveError}
                                    </p>
                                )}
                            </div>
                        );
                    })()}
                </section>

                {/* ── Models (read-only) ── */}
                <section aria-labelledby={`${ids}-models`} className="space-y-3">
                    <div className="space-y-1">
                        <h3 id={`${ids}-models`} className="text-sm font-semibold text-ink">
                            {t("engineSettings.models.title")}
                        </h3>
                        <p className="text-xs text-ink-3">{t("engineSettings.models.description")}</p>
                    </div>

                    {models.state === "loading" && <Spinner size="sm" label={t("common.loading")} />}
                    {models.state === "error" && (
                        <p className="bb-hairline rounded-xl bg-surface-2 p-3 text-sm text-ink-3">{t("engineSettings.models.unavailable")}</p>
                    )}
                    {models.state === "ready" && <ModelsView models={models.value} />}
                </section>
            </div>
        </Modal>
    );
}

/**
 * A small label in this edition's own tokens. (The shared status pill's success, info
 * and danger tones point at platform tokens this theme does not define.)
 */
const PILL_TONES = {
    neutral: "bg-muted text-ink-2",
    brand: "bg-brand-soft text-brand",
    positive: "bg-muted text-positive",
    warning: "bg-warning-subtle text-warning-subtle-foreground",
    danger: "bg-destructive/10 text-destructive",
} as const;

function Pill({ tone, className, children }: { tone: keyof typeof PILL_TONES; className?: string; children: ReactNode }) {
    return (
        <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-2xs font-medium whitespace-nowrap ${PILL_TONES[tone]} ${className ?? ""}`}>
            {children}
        </span>
    );
}

const KIND_ORDER: ModelProvider["kind"][] = ["llm", "image", "stock"];

function ModelsView({ models }: { models: EngineModels }) {
    const t = useT();
    const kindLabel = (kind: ModelProvider["kind"]) =>
        t(kind === "llm" ? "engineSettings.models.kindLlm" : kind === "image" ? "engineSettings.models.kindImage" : "engineSettings.models.kindStock");
    const shown = models.providers
        .filter((p) => p.status !== "disabled")
        .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.id.localeCompare(b.id));

    return (
        <div className="space-y-4">
            <div className="space-y-2">
                <h4 className="text-xs font-medium text-ink-2">{t("engineSettings.models.providersTitle")}</h4>
                {shown.length === 0 ? (
                    <p className="text-xs text-ink-3">{t("engineSettings.models.noProviders")}</p>
                ) : (
                    <ul className="bb-hairline divide-y divide-hairline rounded-xl bg-surface-2">
                        {shown.map((p) => (
                            <li key={`${p.kind}:${p.id}`} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                                <span className="font-mono text-ink">{p.id}</span>
                                <span className="text-xs text-ink-3">{kindLabel(p.kind)}</span>
                                <span className="ml-auto flex items-center gap-1.5">
                                    {p.status === "enabled" && !p.adapterReady && (
                                        <Pill tone="warning">{t("engineSettings.models.adapterMissing")}</Pill>
                                    )}
                                    <Pill tone={p.status === "enabled" ? "positive" : "danger"}>
                                        {t(p.status === "enabled" ? "engineSettings.models.statusEnabled" : "engineSettings.models.statusMisconfigured")}
                                    </Pill>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="space-y-2">
                <h4 className="text-xs font-medium text-ink-2">{t("engineSettings.models.assignmentsTitle")}</h4>
                {models.assignments.length === 0 ? (
                    <p className="text-xs text-ink-3">{t("engineSettings.models.noAssignments")}</p>
                ) : (
                    <ul className="bb-hairline divide-y divide-hairline rounded-xl bg-surface-2">
                        {models.assignments.map((a) => (
                            <li key={a.role} className="space-y-0.5 px-3 py-2 text-sm">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="w-24 shrink-0 text-ink-2">{a.role}</span>
                                    <span className={`min-w-0 break-all font-mono text-xs ${a.model ? "text-ink" : "text-ink-4"}`}>
                                        {a.model ?? t("engineSettings.models.noModel")}
                                    </span>
                                    <Pill className="ml-auto" tone="neutral">
                                        {t(a.source === "env" ? "engineSettings.models.sourceEnv" : "engineSettings.models.sourceAuto")}
                                    </Pill>
                                </div>
                                {a.error && <p className="text-xs text-destructive">{a.error}</p>}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
