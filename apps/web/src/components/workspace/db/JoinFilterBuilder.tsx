"use client";

import * as React from "react";
import { CodeIcon, LoaderIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useT } from "@/i18n";
import type { TranslationKey } from "@/i18n";
import {
    addToGroup,
    compileJoinFilter,
    countRules,
    emptyGroup,
    emptyRule,
    filterTargetsFor,
    isGroup,
    operatorTakesList,
    operatorTakesValue,
    operatorsForKind,
    previewQuery,
    removeNode,
    updateNode,
    type JoinGroup,
    type JoinNode,
    type JoinOperator,
    type JoinRule,
} from "@/lib/join-filter";
import { fieldKindOf, optionsOf, SYSTEM_FIELDS } from "@/lib/totalum-schema";
import type { DbTable } from "@/lib/vcaas-types";
import { cn } from "@/lib/utils";

/**
 * ═══ THE VISUAL JOIN FILTER (Feature H3) ════════════════════════════════════
 *
 * Filter across linked tables without writing a query.
 *
 * ── THE DESIGN RULE: A ROW READS AS A SENTENCE ──────────────────────────────
 *
 * Every rule is `[where] [field] [operator] [value]`, left to right, in that
 * order — because that is the order the thought arrives in. The `[where]` select
 * is what makes joins approachable: it lists the table itself first, then each
 * related table by NAME ("Orders", "Comments"), so "clients who have a paid
 * order" is three menus and a word, not a nested JSON literal.
 *
 * ⚠️ THE OPERATOR MENU IS DERIVED FROM THE FIELD, not fixed. Offering `contains`
 * on a date or `>` on an options field is how a builder starts feeling like a
 * puzzle. `operatorsForKind` owns that list.
 *
 * ⚠️ ONE OR-GROUP PER AND-LEVEL. Totalum's `_filter` has `_or` but no `_and`, so
 * two sibling OR groups under one AND cannot both be expressed — the second would
 * silently overwrite the first. The builder therefore offers "add a group" only
 * where it can be compiled faithfully. See `mergeNested` in `@/lib/join-filter`.
 *
 * ── THE GENERATED QUERY IS VISIBLE, READ-ONLY ───────────────────────────────
 *
 * So someone who knows the API can check our work, and someone who does not can
 * learn the DSL by watching it change. Read-only because an editable one would be
 * a second source of truth that silently disagrees with the controls above it.
 */

export interface JoinFilterBuilderProps {
    tables: DbTable[];
    table: DbTable | undefined;
    root: JoinGroup;
    onChange: (next: JoinGroup) => void;
    /** Live count of matching records, or `null` while unknown. */
    matchCount: number | null;
    counting: boolean;
    onApply: () => void;
    onClear: () => void;
}

export function JoinFilterBuilder({
    tables,
    table,
    root,
    onChange,
    matchCount,
    counting,
    onApply,
    onClear,
}: JoinFilterBuilderProps) {
    const t = useT();
    const [showQuery, setShowQuery] = React.useState(false);

    const targets = React.useMemo(() => filterTargetsFor(tables, table), [tables, table]);
    const compiled = React.useMemo(
        () => compileJoinFilter(root, tables, table),
        [root, tables, table]
    );
    const ruleCount = countRules(root);

    return (
        <div className="border-border bg-card space-y-3 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <p className="text-xs font-medium">{t("workspace.database.filter.title")}</p>
                    <p className="text-muted-foreground text-[11px]">
                        {t("workspace.database.filter.subtitle")}
                    </p>
                </div>

                {/* ⭐ The live count is the feedback loop that makes a builder
                    learnable: you see what a rule DID, immediately. */}
                <div className="flex items-center gap-2">
                    {counting ? (
                        <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                            <LoaderIcon className="size-3 animate-spin" aria-hidden />
                            {t("workspace.database.filter.counting")}
                        </span>
                    ) : matchCount !== null ? (
                        <span className="text-xs font-medium tabular-nums" aria-live="polite">
                            {t("workspace.database.filter.matches", { count: String(matchCount) })}
                        </span>
                    ) : null}
                </div>
            </div>

            <GroupEditor
                group={root}
                depth={0}
                targets={targets}
                onChange={onChange}
                root={root}
            />

            <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    onClick={() => onChange(addToGroup(root, root.id, emptyRule()))}
                >
                    <PlusIcon className="size-3.5" aria-hidden />
                    {t("workspace.database.filter.addCondition")}
                </Button>

                {/* Only ONE group per level — see the header note. */}
                {!root.children.some(isGroup) && (
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 text-xs"
                        onClick={() => onChange(addToGroup(root, root.id, emptyGroup("or")))}
                    >
                        <PlusIcon className="size-3.5" aria-hidden />
                        {t("workspace.database.filter.addGroup")}
                    </Button>
                )}

                <div className="ml-auto flex items-center gap-2">
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 text-xs"
                        onClick={() => setShowQuery(current => !current)}
                        aria-expanded={showQuery}
                    >
                        <CodeIcon className="size-3.5" aria-hidden />
                        {t(showQuery ? "workspace.database.filter.hideQuery" : "workspace.database.filter.showQuery")}
                    </Button>

                    {ruleCount > 0 && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground h-7 text-xs"
                            onClick={onClear}
                        >
                            {t("workspace.database.filter.clear")}
                        </Button>
                    )}

                    <Button type="button" size="sm" className="h-7 text-xs" onClick={onApply}>
                        {t("workspace.database.filter.apply")}
                    </Button>
                </div>
            </div>

            {showQuery && (
                <div>
                    <p className="text-muted-foreground mb-1 text-[11px]">
                        {t("workspace.database.filter.queryHint")}
                    </p>
                    <pre className="bg-muted/60 border-border max-h-40 overflow-auto rounded-md border p-2 font-mono text-[11px] leading-relaxed">
                        <code>{previewQuery(compiled)}</code>
                    </pre>
                </div>
            )}
        </div>
    );
}

function GroupEditor({
    group,
    depth,
    targets,
    onChange,
    root,
}: {
    group: JoinGroup;
    depth: number;
    targets: ReturnType<typeof filterTargetsFor>;
    onChange: (next: JoinGroup) => void;
    root: JoinGroup;
}) {
    const t = useT();

    if (group.children.length === 0 && depth === 0) {
        return (
            <p className="text-muted-foreground border-border rounded-md border border-dashed py-4 text-center text-xs">
                {t("workspace.database.filter.empty")}
            </p>
        );
    }

    return (
        <ul className={cn("space-y-1.5", depth > 0 && "border-border/70 ml-1 border-l pl-3")}>
            {group.children.map((child, index) => (
                <li key={child.id} className="space-y-1.5">
                    {/* The AND/OR word sits BETWEEN rows, where the logic actually
                        lives — a per-row combinator select reads as if each row had
                        its own operator. */}
                    {index > 0 && (
                        <div className="flex items-center gap-2">
                            <Select
                                value={group.combinator}
                                onValueChange={next =>
                                    onChange(
                                        updateNode(root, group.id, {
                                            ...group,
                                            combinator: next as "and" | "or",
                                        })
                                    )
                                }
                            >
                                <SelectTrigger className="h-6 w-20 text-[11px]" aria-label={t("workspace.database.filter.combinator")}>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="and">{t("workspace.database.filter.and")}</SelectItem>
                                    <SelectItem value="or">{t("workspace.database.filter.or")}</SelectItem>
                                </SelectContent>
                            </Select>
                            <span className="border-border/60 h-px flex-1 border-t" />
                        </div>
                    )}

                    {isGroup(child) ? (
                        <div className="border-border/70 bg-muted/20 rounded-md border p-2">
                            <div className="mb-1.5 flex items-center justify-between">
                                <span className="text-muted-foreground text-[11px]">
                                    {t("workspace.database.filter.groupLabel")}
                                </span>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="text-muted-foreground hover:text-destructive size-6"
                                    onClick={() => onChange(removeNode(root, child.id))}
                                    aria-label={t("workspace.database.filter.removeGroup")}
                                >
                                    <Trash2Icon className="size-3" aria-hidden />
                                </Button>
                            </div>

                            <GroupEditor
                                group={child}
                                depth={depth + 1}
                                targets={targets}
                                onChange={onChange}
                                root={root}
                            />

                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="mt-1.5 h-6 gap-1 text-[11px]"
                                onClick={() => onChange(addToGroup(root, child.id, emptyRule()))}
                            >
                                <PlusIcon className="size-3" aria-hidden />
                                {t("workspace.database.filter.addCondition")}
                            </Button>
                        </div>
                    ) : (
                        <RuleEditor
                            rule={child}
                            targets={targets}
                            onChange={next => onChange(updateNode(root, child.id, next))}
                            onRemove={() => onChange(removeNode(root, child.id))}
                        />
                    )}
                </li>
            ))}
        </ul>
    );
}

function RuleEditor({
    rule,
    targets,
    onChange,
    onRemove,
}: {
    rule: JoinRule;
    targets: ReturnType<typeof filterTargetsFor>;
    onChange: (next: JoinRule) => void;
    onRemove: () => void;
}) {
    const t = useT();

    const target = targets.find(candidate => candidate.via === rule.via) ?? targets[0];
    const properties = (target?.properties ?? []).filter(
        p => !SYSTEM_FIELDS.has(p.name) || p.name === "createdAt" || p.name === "_id"
    );
    const property = properties.find(p => p.name === rule.field);
    const kind = property ? fieldKindOf(property) : "string";
    const operators = operatorsForKind(kind);
    const options = property ? optionsOf(property) : [];

    // Keep the operator valid when the field changes underneath it.
    React.useEffect(() => {
        if (rule.field && !operators.includes(rule.operator)) {
            onChange({ ...rule, operator: operators[0] });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rule.field, kind]);

    return (
        <div className="flex flex-wrap items-center gap-1.5">
            {/* WHERE — the table. First entry is the browsed table itself. */}
            <Select
                value={rule.via ?? "__self__"}
                onValueChange={next =>
                    onChange({ ...rule, via: next === "__self__" ? null : next, field: "" })
                }
            >
                <SelectTrigger className="h-7 w-auto min-w-28 text-xs" aria-label={t("workspace.database.filter.whereLabel")}>
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {targets.map(candidate => (
                        <SelectItem key={candidate.via ?? "__self__"} value={candidate.via ?? "__self__"}>
                            {candidate.via === null
                                ? t("workspace.database.filter.thisTable", { table: candidate.label })
                                : t("workspace.database.filter.relatedTable", { table: candidate.label })}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            {/* FIELD */}
            <Select value={rule.field} onValueChange={next => onChange({ ...rule, field: next })}>
                <SelectTrigger className="h-7 w-auto min-w-28 text-xs" aria-label={t("workspace.database.filter.fieldLabel")}>
                    <SelectValue placeholder={t("workspace.database.filter.pickField")} />
                </SelectTrigger>
                <SelectContent>
                    {properties.map(candidate => (
                        <SelectItem key={candidate.name} value={candidate.name}>
                            {candidate.label || candidate.name}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            {/* OPERATOR */}
            <Select
                value={rule.operator}
                onValueChange={next => onChange({ ...rule, operator: next as JoinOperator })}
            >
                <SelectTrigger className="h-7 w-auto min-w-24 text-xs" aria-label={t("workspace.database.filter.operatorLabel")}>
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {operators.map(operator => (
                        <SelectItem key={operator} value={operator}>
                            {t(`workspace.database.filter.op.${operator}` as TranslationKey)}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            {/* VALUE — absent for isEmpty/isNotEmpty, a menu for options fields. */}
            {operatorTakesValue(rule.operator) &&
                (options.length > 0 && !operatorTakesList(rule.operator) ? (
                    <Select value={rule.value} onValueChange={next => onChange({ ...rule, value: next })}>
                        <SelectTrigger className="h-7 w-auto min-w-28 text-xs" aria-label={t("workspace.database.filter.valueLabel")}>
                            <SelectValue placeholder={t("workspace.database.filter.pickValue")} />
                        </SelectTrigger>
                        <SelectContent>
                            {options.map(option => (
                                <SelectItem key={option.id} value={option.value}>
                                    {option.value}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                ) : (
                    <Input
                        value={rule.value}
                        onChange={event => onChange({ ...rule, value: event.target.value })}
                        placeholder={
                            operatorTakesList(rule.operator)
                                ? t("workspace.database.filter.listPlaceholder")
                                : t("workspace.database.filter.valuePlaceholder")
                        }
                        type={kind === "number" ? "number" : kind === "date" ? "date" : kind === "datetime" ? "datetime-local" : "text"}
                        className="h-7 w-36 text-xs"
                        aria-label={t("workspace.database.filter.valueLabel")}
                    />
                ))}

            <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-destructive size-7 shrink-0"
                onClick={onRemove}
                aria-label={t("workspace.database.filter.removeCondition")}
            >
                <Trash2Icon className="size-3.5" aria-hidden />
            </Button>
        </div>
    );
}
