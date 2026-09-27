"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { site } from "@/content/site";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto grid max-w-xl gap-4 px-4 py-24 text-center">
      <h1 className="text-2xl font-semibold">{site.error.title}</h1>
      <p className="text-muted-foreground">{site.error.body}</p>
      <div>
        <Button onClick={reset}>{site.error.retry}</Button>
      </div>
    </div>
  );
}
