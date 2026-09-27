/**
 * In-memory `DockerApi` for unit tests: records every call and keeps just enough state
 * (networks, volumes, containers with status and networks) to drive the manager.
 * Protects: unit tests never touch a real daemon.
 */
import type { ContainerSpec, ContainerState, DockerApi, ExecOptions, ExecResult, NetworkSpec } from "../src/docker.js";

export interface Call {
  op: string;
  args: unknown[];
}

interface FakeContainer {
  spec: ContainerSpec;
  status: string;
  networks: Set<string>;
}

export class FakeDocker implements DockerApi {
  calls: Call[] = [];
  images = new Set<string>(["forja-runner:test", "postgres:17-alpine", "alpine:3.22"]);
  networks = new Map<string, NetworkSpec>();
  volumes = new Map<string, Record<string, string>>();
  containers = new Map<string, FakeContainer>();
  execs: { container: string; argv: readonly string[]; options: ExecOptions }[] = [];
  execResult: (container: string, argv: readonly string[]) => ExecResult = () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    truncated: false,
    timedOut: false,
    durationMs: 1,
  });

  private record(op: string, ...args: unknown[]): void {
    this.calls.push({ op, args });
  }

  ops(): string[] {
    return this.calls.map((c) => `${c.op}:${String(c.args[0])}${c.args[1] !== undefined && typeof c.args[1] === "string" ? `>${c.args[1]}` : ""}`);
  }

  async inspectNetwork(name: string) {
    const spec = this.networks.get(name);
    return spec ? { id: name, name, internal: spec.Internal, labels: spec.Labels, options: spec.Options } : null;
  }
  async createNetwork(spec: NetworkSpec) {
    this.record("createNetwork", spec.Name, spec);
    this.networks.set(spec.Name, spec);
  }
  async removeNetwork(name: string) {
    this.record("removeNetwork", name);
    for (const c of this.containers.values()) {
      if (c.networks.has(name)) throw new Error(`network ${name} has active endpoints`);
    }
    return this.networks.delete(name);
  }
  async connectNetwork(network: string, container: string, aliases?: string[]) {
    this.record("connectNetwork", network, container, aliases);
    if (!this.networks.has(network)) throw new Error(`no network ${network}`);
    this.containers.get(container)?.networks.add(network);
  }
  async disconnectNetwork(network: string, container: string) {
    this.record("disconnectNetwork", network, container);
    return this.containers.get(container)?.networks.delete(network) ?? false;
  }
  async volumeExists(name: string) {
    return this.volumes.has(name);
  }
  async createVolume(name: string, labels: Record<string, string>) {
    this.record("createVolume", name, labels);
    this.volumes.set(name, labels);
  }
  async removeVolume(name: string) {
    this.record("removeVolume", name);
    return this.volumes.delete(name);
  }
  async imageExists(image: string) {
    return this.images.has(image);
  }
  async inspectContainer(name: string): Promise<ContainerState | null> {
    const c = this.containers.get(name);
    if (!c) return null;
    return {
      id: name,
      name,
      status: c.status,
      running: c.status === "running",
      exitCode: 0,
      health: c.spec.Healthcheck ? (c.status === "running" ? "healthy" : null) : null,
      labels: c.spec.Labels ?? {},
      networks: [...c.networks],
      image: c.spec.Image,
      hostConfig: c.spec.HostConfig as unknown as Record<string, unknown>,
    };
  }
  async createContainer(spec: ContainerSpec) {
    this.record("createContainer", spec.name, spec);
    const networks = new Set(Object.keys(spec.NetworkingConfig?.EndpointsConfig ?? {}));
    for (const n of networks) if (!this.networks.has(n)) throw new Error(`no network ${n}`);
    this.containers.set(spec.name, { spec, status: "created", networks });
  }
  async startContainer(name: string) {
    this.record("startContainer", name);
    const c = this.containers.get(name);
    if (!c) throw new Error(`no container ${name}`);
    for (const n of c.networks) if (!this.networks.has(n)) throw new Error(`network ${n} not found`);
    c.status = "running";
  }
  async stopContainer(name: string) {
    this.record("stopContainer", name);
    const c = this.containers.get(name);
    if (c) c.status = "exited";
  }
  async restartContainer(name: string) {
    this.record("restartContainer", name);
    const c = this.containers.get(name);
    if (c) c.status = "running";
  }
  async removeContainer(name: string) {
    this.record("removeContainer", name);
    return this.containers.delete(name);
  }
  async waitContainer(name: string) {
    this.record("waitContainer", name);
    return 0;
  }
  async listContainers(labels: Record<string, string>) {
    const out: ContainerState[] = [];
    for (const name of this.containers.keys()) {
      const state = await this.inspectContainer(name);
      if (state && Object.entries(labels).every(([k, v]) => state.labels[k] === v)) out.push(state);
    }
    return out;
  }
  async exec(container: string, argv: readonly string[], options: ExecOptions = {}) {
    this.record("exec", container, argv);
    this.execs.push({ container, argv, options });
    return this.execResult(container, argv);
  }
  async logs(container: string) {
    this.record("logs", container);
    return "";
  }
}
