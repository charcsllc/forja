import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * ═══ THE MARK AND THE WORDMARK ═══════════════════════════════════════════════
 *
 * Two offset building blocks carrying the brand gradient (blue → pink → orange). It
 * is deliberately our own shape: this project is an alternative to Lovable, and their
 * heart is their trademark. Keep the mark in sync with `src/app/icon.svg`.
 */
export function LogoMark({ className, size = 24 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={cn("shrink-0", className)}
    >
      <defs>
        <linearGradient id="bb-mark-a" x1="4" y1="28" x2="28" y2="4" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4B73FF" />
          <stop offset="0.5" stopColor="#FF3FA8" />
          <stop offset="1" stopColor="#FF8A1D" />
        </linearGradient>
        <linearGradient id="bb-mark-b" x1="12" y1="20" x2="28" y2="4" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FF2E63" />
          <stop offset="1" stopColor="#FFB13B" />
        </linearGradient>
      </defs>
      <rect x="3" y="11" width="18" height="18" rx="6" fill="url(#bb-mark-a)" />
      <rect x="11" y="3" width="18" height="18" rx="6" fill="url(#bb-mark-b)" fillOpacity="0.94" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-semibold tracking-[-0.02em] text-ink", className)}>{BRAND.name}</span>
  );
}

/** Mark + wordmark, linking home. */
export function Logo({ className, href = "/", markSize = 24 }: { className?: string; href?: string; markSize?: number }) {
  return (
    <Link href={href} className={cn("inline-flex items-center gap-2", className)} aria-label={`${BRAND.name} home`}>
      <LogoMark size={markSize} />
      <Wordmark className="text-[15px]" />
    </Link>
  );
}
