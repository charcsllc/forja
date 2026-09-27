"use client";

/**
 * Monaco, bundled with the app instead of loaded from jsDelivr.
 *
 * `@monaco-editor/react` defaults to fetching the editor from cdn.jsdelivr.net the first
 * time an editor mounts, which tells a third party every user's IP and when they opened
 * the Code tab. `loader.config({ monaco })` hands it the local `monaco-editor` package
 * instead, and `MonacoEnvironment.getWorker` serves the language workers from
 * `/_next/static`. Each worker has its own one-line wrapper next to this file so the
 * bundler sees a relative path inside `new URL(...)`, never a bare package specifier.
 *
 * ⚠️ Import this module only through `dynamic(..., { ssr: false })`: monaco touches
 * `self` and `document` when it loads.
 */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "json") {
      return new Worker(new URL("./json.worker.ts", import.meta.url), { type: "module" });
    }
    if (label === "css" || label === "scss" || label === "less") {
      return new Worker(new URL("./css.worker.ts", import.meta.url), { type: "module" });
    }
    if (label === "html" || label === "handlebars" || label === "razor") {
      return new Worker(new URL("./html.worker.ts", import.meta.url), { type: "module" });
    }
    if (label === "typescript" || label === "javascript") {
      return new Worker(new URL("./ts.worker.ts", import.meta.url), { type: "module" });
    }
    return new Worker(new URL("./editor.worker.ts", import.meta.url), { type: "module" });
  },
};

// Must run before any <Editor> mounts, so the loader never injects the CDN script.
loader.config({ monaco });

export { default } from "@monaco-editor/react";
