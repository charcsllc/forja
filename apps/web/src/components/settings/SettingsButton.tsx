"use client";

import { useState } from "react";
import { Settings } from "lucide-react";

import { useT } from "@/i18n";
import { useBackendConfig } from "@/lib/use-backend-config";
import { cn } from "@/lib/utils";

import { SettingsModal } from "./SettingsModal";

/**
 * The gear that opens Settings, in the home header and the workspace header.
 *
 * ⚠️ ENGINE ONLY. With Totalum there is nothing to set (images and models are Totalum's),
 * so the gear renders nothing. `useBackendConfig` answers Totalum until `/api/config`
 * says otherwise, so the gear never flashes in the Totalum edition.
 */
export function SettingsButton({ className }: { className?: string }) {
    const t = useT();
    const { backend } = useBackendConfig();
    const [open, setOpen] = useState(false);
    if (backend !== "engine") return null;
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                title={t("engineSettings.open")}
                aria-label={t("engineSettings.open")}
                aria-haspopup="dialog"
                className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-muted hover:text-ink focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    className
                )}
            >
                <Settings className="size-4" aria-hidden />
            </button>
            {open && <SettingsModal open={open} onOpenChange={setOpen} />}
        </>
    );
}
