"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeftIcon, RefreshCwIcon, WalletIcon } from "lucide-react";

import { LogoMark } from "@/components/brand/Logo";
import { EmptyState, ErrorState, PageHeader, Section, SkeletonBox, SkeletonTable } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══ forja: PROJECT BUDGET (Forja Engine) ════════════════════════════════════
 *
 * Where `InsufficientCreditsModal` sends the user when the engine refuses work with
 * `INSUFFICIENT_CREDITS` (a run or monthly budget ran out). Read-only: limits are set on
 * the engine (`BUDGET_PER_RUN_USD`, `BUDGET_PER_PROJECT_MONTH_USD`, …), not here.
 *
 * Data: `GET /api/budget/<id>` → engine `GET /v2/projects/<id>/budget` (05 §3). With the
 * Totalum backend that route answers `NOT_AVAILABLE` and the page says why.
 */
interface MonthTotals {
    monthSpentUsd: number;
    monthBudgetUsd: number | null;
}

interface BudgetRun {
    id: string;
    startedAt: string;
    status: string;
    spentUsd: number;
    budgetUsd: number | null;
}

interface BudgetReport {
    project: MonthTotals;
    runs: BudgetRun[];
    global: MonthTotals;
}

type LoadState =
    | { kind: "loading" }
    | { kind: "ready"; report: BudgetReport }
    | { kind: "unavailable" }
    | { kind: "error"; detail?: string };

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Small amounts matter here (a run can cost cents), so show 4 decimals below one dollar. */
function formatUsd(value: number | null | undefined): string {
    const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
    if (n > 0 && n < 1) return `$${n.toFixed(4)}`;
    return usd.format(n);
}

function num(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
}

function numOrNull(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}

/** Tolerant parse: the engine is the authority, but a missing field must not blank the page. */
function toReport(raw: unknown): BudgetReport {
    const r = (raw ?? {}) as Record<string, any>;
    const totals = (t: any): MonthTotals => ({ monthSpentUsd: num(t?.monthSpentUsd), monthBudgetUsd: numOrNull(t?.monthBudgetUsd) });
    const runs: BudgetRun[] = Array.isArray(r.runs)
        ? r.runs.map((run: any) => ({
              id: String(run?.id ?? ""),
              startedAt: String(run?.startedAt ?? ""),
              status: String(run?.status ?? ""),
              spentUsd: num(run?.spentUsd),
              budgetUsd: numOrNull(run?.budgetUsd),
          }))
        : [];
    return { project: totals(r.project), runs, global: totals(r.global) };
}

function ratio(spent: number, budget: number | null): number | null {
    if (budget === null || budget <= 0) return null;
    return spent / budget;
}

function Meter({ value }: { value: number | null }) {
    if (value === null) return null;
    const pct = Math.max(0, Math.min(1, value)) * 100;
    return (
        <div
            className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(value * 100)}
        >
            <div
                className={cn(
                    "h-full rounded-full transition-[width]",
                    value >= 1 ? "bg-destructive" : value >= 0.8 ? "bg-warning" : "bg-brand"
                )}
                style={{ width: `${pct}%` }}
            />
        </div>
    );
}

function TotalsCard({ label, totals }: { label: string; totals: MonthTotals }) {
    const t = useT();
    const r = ratio(totals.monthSpentUsd, totals.monthBudgetUsd);
    const budget = totals.monthBudgetUsd;
    return (
        <div className="bg-card space-y-3 rounded-xl border p-5 shadow-2xs">
            <p className="text-muted-foreground text-2xs font-medium tracking-widest uppercase">{label}</p>
            <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-ink text-2xl font-semibold tabular-nums">{formatUsd(totals.monthSpentUsd)}</span>
                <span className="text-ink-3 text-sm">
                    {budget === null ? t("budget.noLimit") : t("budget.ofBudget", { budget: formatUsd(budget) })}
                </span>
            </div>
            <Meter value={r} />
            {budget !== null ? (
                <p className={cn("text-xs", totals.monthSpentUsd > budget ? "text-destructive" : "text-ink-3")}>
                    {totals.monthSpentUsd > budget
                        ? t("budget.overBudget", { amount: formatUsd(totals.monthSpentUsd - budget) })
                        : t("budget.remaining", { amount: formatUsd(budget - totals.monthSpentUsd) })}
                </p>
            ) : null}
        </div>
    );
}

const STATUS_CLASS: Record<string, string> = {
    done: "bg-positive/10 text-positive",
    success: "bg-positive/10 text-positive",
    running: "bg-brand-soft text-brand",
    init: "bg-brand-soft text-brand",
    directing: "bg-brand-soft text-brand",
    building: "bg-brand-soft text-brand",
    "limit-reached": "bg-warning-subtle text-warning-subtle-foreground",
    failed: "bg-destructive/10 text-destructive",
    error: "bg-destructive/10 text-destructive",
};

function RunStatus({ status }: { status: string }) {
    return (
        <span
            className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
                STATUS_CLASS[status] ?? "bg-muted text-muted-foreground"
            )}
        >
            {status || "—"}
        </span>
    );
}

export default function BudgetPage() {
    const t = useT();
    const { projectId } = useParams<{ projectId: string }>();
    const [state, setState] = useState<LoadState>({ kind: "loading" });
    const [refreshing, setRefreshing] = useState(false);

    const load = useCallback(async () => {
        setRefreshing(true);
        try {
            const res = await fetch(`/api/budget/${encodeURIComponent(projectId)}`, { cache: "no-store" });
            const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: unknown; code?: string; error?: string } | null;
            if (json?.ok) setState({ kind: "ready", report: toReport(json.data) });
            else if (json?.code === "NOT_AVAILABLE") setState({ kind: "unavailable" });
            else setState({ kind: "error", detail: json?.error ?? `HTTP ${res.status}` });
        } catch (error) {
            setState({ kind: "error", detail: error instanceof Error ? error.message : String(error) });
        } finally {
            setRefreshing(false);
        }
    }, [projectId]);

    useEffect(() => {
        void load();
    }, [load]);

    const projectHref = `/project/${encodeURIComponent(projectId)}`;

    return (
        <div className="bg-surface-1 min-h-screen">
            <div className="mx-auto w-full max-w-4xl space-y-8 px-4 py-8 sm:px-6 sm:py-12">
                <div className="flex items-center justify-between gap-3">
                    <Link href="/" aria-label="Home" className="shrink-0">
                        <LogoMark size={28} />
                    </Link>
                    <Button asChild variant="outline" size="sm" className="gap-1.5">
                        <Link href={projectHref}>
                            <ArrowLeftIcon className="size-4" aria-hidden />
                            {t("budget.backToProject")}
                        </Link>
                    </Button>
                </div>

                <PageHeader
                    eyebrow={t("budget.eyebrow")}
                    title={t("budget.title", { project: projectId })}
                    description={t("budget.description")}
                    actions={
                        state.kind === "ready" || state.kind === "error" ? (
                            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void load()} disabled={refreshing}>
                                <RefreshCwIcon className={cn("size-4", refreshing && "animate-spin")} aria-hidden />
                                {t("budget.refresh")}
                            </Button>
                        ) : null
                    }
                />

                {state.kind === "loading" ? (
                    <div className="space-y-6">
                        <div className="grid gap-4 sm:grid-cols-2">
                            <SkeletonBox className="h-32 rounded-xl" />
                            <SkeletonBox className="h-32 rounded-xl" />
                        </div>
                        <SkeletonTable />
                    </div>
                ) : state.kind === "unavailable" ? (
                    <EmptyState
                        variant="panel"
                        icon={<WalletIcon className="size-5" aria-hidden />}
                        title={t("budget.unavailableTitle")}
                        description={t("budget.unavailableDescription")}
                    />
                ) : state.kind === "error" ? (
                    <ErrorState
                        variant="panel"
                        title={t("budget.loadFailed")}
                        description={t("budget.loadFailedDescription")}
                        detail={state.detail}
                        onRetry={() => void load()}
                        retrying={refreshing}
                        secondaryHref={projectHref}
                        secondaryLabel={t("budget.backToProject")}
                    />
                ) : (
                    <>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <TotalsCard label={t("budget.projectMonth")} totals={state.report.project} />
                            <TotalsCard label={t("budget.globalMonth")} totals={state.report.global} />
                        </div>

                        <Section title={t("budget.runsTitle")} description={t("budget.runsDescription")} flush>
                            {state.report.runs.length === 0 ? (
                                <EmptyState
                                    variant="panel"
                                    title={t("budget.emptyTitle")}
                                    description={t("budget.emptyDescription")}
                                />
                            ) : (
                                <div className="overflow-x-auto">
                                    <table className="w-full min-w-[560px] text-sm">
                                        <thead>
                                            <tr className="text-ink-3 border-b text-left text-xs">
                                                <th className="px-5 py-3 font-medium">{t("budget.colStarted")}</th>
                                                <th className="px-5 py-3 font-medium">{t("budget.colStatus")}</th>
                                                <th className="px-5 py-3 text-right font-medium">{t("budget.colSpent")}</th>
                                                <th className="px-5 py-3 text-right font-medium">{t("budget.colBudget")}</th>
                                                <th className="w-40 px-5 py-3 font-medium">{t("budget.colUsage")}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {state.report.runs.map((run) => (
                                                <tr key={run.id || run.startedAt} className="border-b last:border-b-0">
                                                    <td className="text-ink-2 px-5 py-3 whitespace-nowrap">
                                                        {formatDateTime(run.startedAt, "en") || "—"}
                                                    </td>
                                                    <td className="px-5 py-3">
                                                        <RunStatus status={run.status} />
                                                    </td>
                                                    <td className="text-ink px-5 py-3 text-right tabular-nums">{formatUsd(run.spentUsd)}</td>
                                                    <td className="text-ink-3 px-5 py-3 text-right tabular-nums">
                                                        {run.budgetUsd === null ? "—" : formatUsd(run.budgetUsd)}
                                                    </td>
                                                    <td className="px-5 py-3">
                                                        <Meter value={ratio(run.spentUsd, run.budgetUsd)} />
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </Section>
                    </>
                )}
            </div>
        </div>
    );
}
