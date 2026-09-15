"use client";

import * as React from "react";
import { SlidersHorizontalIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import type { AgentEffort, AgentModel, AgentRunOptions } from "@/lib/vcaas-types";

/**
 * Model / effort / fast-mode picker for the chat composer's tool tray.
 *
 * Sits in the same `size-8` icon-button footprint as the other tray tools and lights up
 * (ring + primary colour) whenever a non-default option is active, so a Sonnet or fast-mode
 * prompt is never sent by surprise. The choice is remembered per project — see `useRunOptions`.
 *
 * Product rules mirrored from the API (`POST /agent/start`):
 *  · model defaults to Opus; Sonnet is the explicit faster/cheaper choice.
 *  · effort is sent only when the user picked one (the default otherwise).
 *  · fast mode is Opus-only — the option is disabled (and cleared) while Sonnet is selected.
 *  · the menu says so up front: Totalum already routes each prompt to the best model and effort,
 *    so these are for people who know what they are doing.
 */

const EFFORTS: AgentEffort[] = ["low", "medium", "high", "xhigh"];
const DEFAULT_EFFORT = "default";

export interface RunOptionsMenuProps {
    value: AgentRunOptions;
    onChange: (next: AgentRunOptions) => void;
    disabled?: boolean;
}

export function RunOptionsMenu({ value, onChange, disabled }: RunOptionsMenuProps) {
    const t = useT();
    const model: AgentModel = value.model === "sonnet" ? "sonnet" : "opus";
    const isDefault = model === "opus" && !value.effort && !value.fastMode;

    const setModel = (next: string) => {
        const nextModel: AgentModel = next === "sonnet" ? "sonnet" : "opus";
        onChange(normalizeRunOptions({ ...value, model: nextModel }));
    };
    const setEffort = (next: string) => {
        onChange(normalizeRunOptions({ ...value, effort: next === DEFAULT_EFFORT ? undefined : (next as AgentEffort) }));
    };
    const setFastMode = (checked: boolean) => {
        onChange(normalizeRunOptions({ ...value, fastMode: checked }));
    };

    const summary = [
        t(model === "sonnet" ? "workspace.chat.runOptions.modelSonnet" : "workspace.chat.runOptions.modelOpus"),
        value.effort ? t(`workspace.chat.runOptions.effort_${value.effort}`) : null,
        value.fastMode ? t("workspace.chat.runOptions.fastMode") : null,
    ]
        .filter(Boolean)
        .join(" · ");

    return (
        <DropdownMenu>
            <Tooltip>
                <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                        <Button
                            type="button"
                            variant={isDefault ? "ghost" : "secondary"}
                            size="icon"
                            className={cn("size-8 shrink-0", !isDefault && "ring-primary/40 text-primary ring-1")}
                            disabled={disabled}
                            aria-label={t("workspace.chat.runOptions.button")}
                        >
                            <SlidersHorizontalIcon className="size-4" aria-hidden />
                        </Button>
                    </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>
                    {t("workspace.chat.runOptions.button")}: {summary}
                </TooltipContent>
            </Tooltip>

            <DropdownMenuContent align="start" className="w-72">
                <p className="text-muted-foreground px-2 pt-1.5 pb-1 text-xs leading-snug">
                    {t("workspace.chat.runOptions.autoNote")}
                </p>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t("workspace.chat.runOptions.model")}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={model} onValueChange={setModel}>
                    <DropdownMenuRadioItem value="opus" className="flex-col items-start gap-0.5">
                        <span>{t("workspace.chat.runOptions.modelOpus")}</span>
                        <span className="text-muted-foreground text-xs">{t("workspace.chat.runOptions.modelOpusHint")}</span>
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="sonnet" className="flex-col items-start gap-0.5">
                        <span>{t("workspace.chat.runOptions.modelSonnet")}</span>
                        <span className="text-muted-foreground text-xs">{t("workspace.chat.runOptions.modelSonnetHint")}</span>
                    </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>

                <DropdownMenuSeparator />
                <DropdownMenuLabel className="flex flex-col gap-0.5">
                    <span>{t("workspace.chat.runOptions.effort")}</span>
                    <span className="text-muted-foreground text-xs font-normal">{t("workspace.chat.runOptions.effortHint")}</span>
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup value={value.effort ?? DEFAULT_EFFORT} onValueChange={setEffort}>
                    <DropdownMenuRadioItem value={DEFAULT_EFFORT}>
                        {t("workspace.chat.runOptions.effortDefault")}
                    </DropdownMenuRadioItem>
                    {EFFORTS.map(level => (
                        <DropdownMenuRadioItem key={level} value={level}>
                            {t(`workspace.chat.runOptions.effort_${level}`)}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>

                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                    checked={model === "opus" && !!value.fastMode}
                    disabled={model !== "opus"}
                    onCheckedChange={checked => setFastMode(checked === true)}
                    className="flex-col items-start gap-0.5"
                >
                    <span>{t("workspace.chat.runOptions.fastMode")}</span>
                    <span className="text-muted-foreground text-xs">
                        {t(model === "opus" ? "workspace.chat.runOptions.fastModeHint" : "workspace.chat.runOptions.fastModeOpusOnly")}
                    </span>
                </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** Drops defaults so the request body only carries what the user actually chose. */
export function normalizeRunOptions(raw: AgentRunOptions): AgentRunOptions {
    const out: AgentRunOptions = {};
    if (raw.model === "sonnet") out.model = "sonnet";
    if (raw.effort && EFFORTS.includes(raw.effort)) out.effort = raw.effort;
    if (raw.fastMode === true && !out.model) out.fastMode = true; // opus only
    return out;
}

/**
 * The chips shown INSIDE the composer, under the text, whenever a non-default option is set:
 * "Sonnet", "Effort: High", "Fast mode" — each with an × that clears just that option. They make
 * the choice impossible to miss at the moment of sending, and cancelling is one click.
 */
export function RunOptionsChips({ value, onChange, disabled, className }: RunOptionsMenuProps & { className?: string }) {
    const t = useT();
    const chips: { key: string; label: string; clear: () => void }[] = [];
    if (value.model === "sonnet") chips.push({ key: "model", label: t("workspace.chat.runOptions.modelSonnet"), clear: () => onChange(normalizeRunOptions({ ...value, model: undefined })) });
    if (value.effort) chips.push({ key: "effort", label: t("workspace.chat.runOptions.chipEffort", { level: t(`workspace.chat.runOptions.effort_${value.effort}`) }), clear: () => onChange(normalizeRunOptions({ ...value, effort: undefined })) });
    if (value.fastMode) chips.push({ key: "fast", label: t("workspace.chat.runOptions.fastMode"), clear: () => onChange(normalizeRunOptions({ ...value, fastMode: false })) });
    if (!chips.length) return null;
    return (
        <div className={cn("flex flex-wrap items-center gap-1.5", className)} aria-label={t("workspace.chat.runOptions.button")}>
            {chips.map(chip => (
                <span
                    key={chip.key}
                    className="border-primary/25 bg-primary/5 text-primary inline-flex h-6 items-center gap-1 rounded-full border pl-2.5 pr-1 text-xs font-medium"
                >
                    {chip.label}
                    <button
                        type="button"
                        onClick={chip.clear}
                        disabled={disabled}
                        aria-label={t("workspace.chat.runOptions.chipRemove", { option: chip.label })}
                        className="hover:bg-primary/15 focus-visible:ring-primary/40 inline-flex size-4 items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
                    >
                        <XIcon className="size-3" aria-hidden />
                    </button>
                </span>
            ))}
        </div>
    );
}

const STORAGE_PREFIX = "tp_run_options:";

/**
 * Per-project, per-TAB memory of the picker: `sessionStorage`, so a choice lasts for the working
 * session and never silently follows the user into tomorrow. It is a convenience, not a source of
 * truth — the API defaults apply whenever it is empty or unreadable.
 */
export function useRunOptions(projectId: string): [AgentRunOptions, (next: AgentRunOptions) => void] {
    const key = `${STORAGE_PREFIX}${projectId}`;
    const [options, setOptions] = React.useState<AgentRunOptions>({});

    React.useEffect(() => {
        try {
            const raw = window.sessionStorage.getItem(key);
            setOptions(raw ? normalizeRunOptions(JSON.parse(raw) as AgentRunOptions) : {});
            // Older builds remembered this in localStorage; forget it so nothing sticks across sessions.
            try { window.localStorage.removeItem(key); } catch { /* ignore */ }
        } catch {
            setOptions({});
        }
    }, [key]);

    const update = React.useCallback(
        (next: AgentRunOptions) => {
            const normalized = normalizeRunOptions(next);
            setOptions(normalized);
            try {
                if (Object.keys(normalized).length) window.sessionStorage.setItem(key, JSON.stringify(normalized));
                else window.sessionStorage.removeItem(key);
            } catch {
                /* private mode etc. — the in-memory value still applies for this session */
            }
        },
        [key]
    );

    return [options, update];
}
