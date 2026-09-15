import Link from "next/link";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/brand/Logo";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-1 px-4">
      <div className="text-center">
        <LogoMark size={40} className="mx-auto mb-6" />
        <h1 className="text-5xl font-semibold tracking-display text-ink">404</h1>
        <h2 className="mt-2 text-xl font-medium text-ink-2">Page not found</h2>
        <p className="mx-auto mt-3 max-w-md text-sm text-ink-3">
          We could not find that page. Check the URL or head back to your projects.
        </p>
        <div className="mt-8">
          <Link href="/"><Button>Back to projects</Button></Link>
        </div>
      </div>
    </div>
  );
}
