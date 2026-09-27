import { site } from "@/content/site";

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-5xl px-4 py-6 text-sm text-muted-foreground sm:px-6">
        © {new Date().getFullYear()} {site.name}. {site.footer}
      </div>
    </footer>
  );
}
