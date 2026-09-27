import { site } from "@/content/site";

export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="mx-auto grid max-w-5xl gap-4 px-4 py-16 sm:px-6">
      <span className="sr-only">{site.loading}</span>
      <div className="h-10 w-2/3 animate-pulse rounded-md bg-muted" />
      <div className="h-5 w-1/2 animate-pulse rounded-md bg-muted" />
      <div className="h-5 w-1/3 animate-pulse rounded-md bg-muted" />
    </div>
  );
}
