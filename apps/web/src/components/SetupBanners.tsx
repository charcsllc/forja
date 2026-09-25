"use client";

import { KeyRound, Server, Database, Sparkles, Globe, Github, Box, ArrowRight } from "lucide-react";
import { BRAND } from "@/lib/brand";

// Shown on the home page only when the Totalum API key is missing:
// 1) a card telling the operator how to add their key, and
// 2) a compact list of what that single key unlocks.
export function SetupBanners() {
  const FEATURES = [
    { icon: Server, label: "Hosting" },
    { icon: Database, label: "Databases" },
    { icon: Sparkles, label: "AI agent" },
    { icon: Globe, label: "Custom domains" },
    { icon: Github, label: "GitHub sync" },
    { icon: Box, label: "Sandboxes" },
  ];

  return (
    <div className="mt-8 space-y-3">
      <div className="rounded-3xl bg-surface-2 p-5 shadow-card sm:p-6">
        <div className="flex items-start gap-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
            <KeyRound className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="inline-flex items-center rounded-full bg-brand px-2 py-0.5 text-2xs font-medium text-brand-foreground">
              One step left
            </span>
            <h2 className="mt-2 text-lg font-semibold tracking-tight text-ink">Add your Totalum API key</h2>
            <p className="mt-1 text-sm text-ink-2">
              Create a <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[13px] text-ink">.env.local</code> file in the project root and add:
            </p>
            <div className="mt-2.5 overflow-x-auto rounded-xl bg-ink px-3.5 py-2.5 font-mono text-xs text-white/90">
              <span className="text-[#ffb13b]">TOTALUM_VCAAS_API_KEY</span>
              <span className="text-white/50">=</span>
              <span className="text-white/60">your_key_here</span>
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-ink-3">
              <span className="font-medium text-ink-2">Get a key:</span> create an account on Totalum, pick{" "}
              <span className="font-medium text-ink-2">“Use the Totalum API”</span> during onboarding, copy the key. Then restart <code className="font-mono">npm run dev</code>.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
              <a
                href={BRAND.apiKeyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm text-primary-foreground transition-opacity hover:opacity-90"
              >
                Create account <ArrowRight className="size-4" />
              </a>
              <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-positive">
                <Sparkles className="size-3.5" />
                First 50 AI credits free
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-3xl bg-surface-2 p-5 shadow-card sm:p-6">
        <h2 className="text-base font-semibold tracking-tight text-ink">One key. Everything included.</h2>
        <p className="text-[13px] text-ink-3">No other providers to sign up for.</p>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {FEATURES.map(({ icon: Icon, label }) => (
            <div key={label} className="bb-hairline flex items-center gap-2 rounded-xl bg-surface-1 px-3 py-2">
              <Icon className="size-4 shrink-0 text-brand" />
              <span className="truncate text-[13px] font-medium text-ink-2">{label}</span>
            </div>
          ))}
        </div>
        <a
          href={BRAND.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:underline"
        >
          Read the docs <ArrowRight className="size-4" />
        </a>
      </div>
    </div>
  );
}
