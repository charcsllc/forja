"use client";

import { site } from "@/content/site";
import "./globals.css";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang={site.locale}>
      <body className="grid min-h-dvh place-items-center p-6">
        <div className="grid max-w-md gap-4 text-center">
          <h1 className="text-2xl font-semibold">{site.error.title}</h1>
          <p className="text-muted-foreground">{site.error.body}</p>
          <button
            type="button"
            onClick={reset}
            className="mx-auto rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            {site.error.retry}
          </button>
        </div>
      </body>
    </html>
  );
}
