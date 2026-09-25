// Phase 0 stub of the forja-browser sidecar. Only reachable on forja-apps.
import http from "node:http";

const port = Number(process.env.PORT ?? 8080);

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200).end(JSON.stringify({ ok: true, stub: true }));
    return;
  }
  res
    .writeHead(501)
    .end(JSON.stringify({ error: { code: "NOT_IMPLEMENTED", message: "forja-browser arrives in phase 3" } }));
});

server.listen(port, "0.0.0.0", () => console.log(`forja-browser stub on :${port}`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
