/** Runs once when the server starts: starts background job workers (see src/jobs). */
export async function register() {
  // Keep this exact `if` shape: the bundler removes the Node-only import from the edge build.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startJobs } = await import("./jobs/start");
    await startJobs().catch((error: unknown) => {
      console.error("Failed to start background jobs", error);
    });
  }
}
