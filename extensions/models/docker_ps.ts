/**
 * Docker ps — a read-only listing of what is running on a Docker
 * host, safe to hand to an unattended triage agent.
 *
 * The question this answers is the one an alert usually raises first: "what
 * is on that host, and who holds that port?". The listing is deliberately
 * narrow, and the narrowness is the feature:
 *
 * - **Only `docker ps`, with an explicit field list.** The obvious richer
 *   commands are the wrong ones to hand an agent. `docker inspect` returns
 *   every container's environment, which is where compose files put database
 *   passwords and API tokens. `docker ps --format '{{json .}}'` includes the
 *   `Labels` field, whose values carry project paths and, on some stacks,
 *   configuration. This model asks for ID, name, image, state, status, ports
 *   and creation time by name and builds each row from those fields alone, so
 *   a Docker version that adds a field cannot widen what leaves the host.
 *
 * - **No write verb, and no way to add one.** The type has a single method.
 *   Nothing takes a free-form command or format string, so a caller cannot
 *   turn it into `docker exec` or `docker rm`, and a model instance of this
 *   type exposes no destructive method at all.
 *
 * - **Host key checking stays on** (`accept-new` by default). `no` is
 *   available for hosts without a persistent known_hosts, never the default.
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Pure helpers. Exported for tests: none of them touch the network or a host.
// ---------------------------------------------------------------------------

/**
 * The `docker ps --format` template. Every field is named explicitly and
 * JSON-encoded on its own, so a value containing a tab, a quote or a newline
 * cannot shift the columns. `.Labels` and `.Mounts` are absent on purpose.
 */
export const PS_FORMAT =
  '{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}},' +
  '"state":{{json .State}},"status":{{json .Status}},' +
  '"ports":{{json .Ports}},"createdAt":{{json .CreatedAt}}}';

/** The fixed remote command. Nothing caller-supplied is interpolated. */
export function psCommand(all: boolean): string {
  return `docker ps${all ? " -a" : ""} --no-trunc --format '${PS_FORMAT}'`;
}

/** One published or exposed port, parsed from Docker's ports column. */
export interface PortBinding {
  hostIp: string | null;
  hostPort: string | null;
  containerPort: string;
  protocol: string;
}

/**
 * Parse Docker's ports column, e.g.
 * `0.0.0.0:9091->9091/tcp, [::]:9091->9091/tcp, 9090/tcp`.
 *
 * An entry without `->` is exposed but not published, so it has no host side.
 * Ranges (`8000-8001`) are kept as strings rather than expanded. Unparseable
 * entries are skipped, never thrown on.
 */
export function parsePorts(raw: string): PortBinding[] {
  const out: PortBinding[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const arrow = entry.indexOf("->");
    const target = arrow >= 0 ? entry.slice(arrow + 2) : entry;
    const m = target.match(/^([\d-]+)\/(\w+)$/);
    if (!m) continue;
    let hostIp: string | null = null;
    let hostPort: string | null = null;
    if (arrow >= 0) {
      const host = entry.slice(0, arrow);
      const colon = host.lastIndexOf(":");
      if (colon < 0) continue;
      hostIp = host.slice(0, colon).replace(/^\[|\]$/g, "");
      hostPort = host.slice(colon + 1);
    }
    out.push({ hostIp, hostPort, containerPort: m[1], protocol: m[2] });
  }
  return out;
}

/** One container, as this model reports it. */
export interface ContainerRow {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  createdAt: string;
  ports: PortBinding[];
  publishedHostPorts: string[];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Parse the output of {@link psCommand}: one JSON object per line.
 *
 * Each row is rebuilt from the named fields only, so an unexpected field in
 * the input never reaches the output. Malformed lines are skipped.
 */
export function parsePs(stdout: string): ContainerRow[] {
  const rows: ContainerRow[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const id = str(raw.id);
    if (!id) continue;
    const ports = parsePorts(str(raw.ports));
    const published = new Set<string>();
    for (const p of ports) {
      if (p.hostPort) published.add(`${p.hostPort}/${p.protocol}`);
    }
    rows.push({
      id: id.slice(0, 12),
      name: str(raw.name),
      image: str(raw.image),
      state: str(raw.state),
      status: str(raw.status),
      createdAt: str(raw.createdAt),
      ports,
      publishedHostPorts: [...published],
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

/** Build the argument list for an SSH invocation. Host key checking stays on. */
export function sshArgs(
  host: string,
  user: string,
  command: string,
  opts: { strictHostKeyChecking?: string; knownHostsFile?: string } = {},
): string[] {
  const args = [
    "-o",
    `StrictHostKeyChecking=${opts.strictHostKeyChecking ?? "accept-new"}`,
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
  ];
  if (opts.knownHostsFile) {
    args.push("-o", `UserKnownHostsFile=${opts.knownHostsFile}`);
  }
  args.push(`${user}@${host}`, command);
  return args;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * Host and user reach ssh as one `user@host` argument. Refusing a leading `-`
 * and anything but plain name characters keeps either from being read as an
 * ssh option such as `-oProxyCommand=...`.
 */
export const SSH_HOST_RE = /^[A-Za-z0-9\[][A-Za-z0-9.:\[\]_-]*$/;
export const SSH_USER_RE = /^[A-Za-z_][A-Za-z0-9._-]*$/;

const GlobalArgsSchema = z.object({
  sshHost: z.string().regex(SSH_HOST_RE, "not a plain hostname or IP").describe(
    "Docker host to reach over SSH (hostname, alias or IP).",
  ),
  sshUser: z.string().regex(SSH_USER_RE, "not a plain user name").default(
    "root",
  ).describe(
    "SSH user. Needs permission to run `docker ps`, nothing more.",
  ),
  strictHostKeyChecking: z.enum(["yes", "accept-new", "no"]).default(
    "accept-new",
  ).describe("OpenSSH StrictHostKeyChecking. `no` is never the default."),
  knownHostsFile: z.string().optional().describe(
    "Optional UserKnownHostsFile override.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const PortSchema = z.object({
  hostIp: z.string().nullable(),
  hostPort: z.string().nullable(),
  containerPort: z.string(),
  protocol: z.string(),
});

const ContainersSchema = z.object({
  host: z.string(),
  includeStopped: z.boolean(),
  count: z.number(),
  running: z.number(),
  containers: z.array(z.object({
    id: z.string(),
    name: z.string(),
    image: z.string(),
    state: z.string(),
    status: z.string(),
    createdAt: z.string(),
    ports: z.array(PortSchema),
    publishedHostPorts: z.array(z.string()),
  })),
  timestamp: z.string(),
});

interface Context {
  globalArgs: GlobalArgs;
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void };
  writeResource: (
    resource: string,
    instance: string,
    attributes: unknown,
  ) => Promise<unknown>;
}

/**
 * The `@sntxrr/docker-ps/host` model: a read-only container
 * listing of one Docker host.
 */
export const model = {
  type: "@sntxrr/docker-ps/host",
  description:
    "Read-only container listing of a Docker host over SSH: name, image, state, status, published ports and creation time. Uses `docker ps` with an explicit field list only, so no environment variables or label values ever leave the host. Has no write method.",
  version: "2026.10.22.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    containers: {
      description:
        "Every container on the host with its state and port bindings, sorted by name.",
      schema: ContainersSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    ps: {
      description:
        "Read-only. List the host's containers (`docker ps`, explicit fields only): name, image, state, status, published ports, created. No env, no labels. Answers 'who holds port N' via `publishedHostPorts`.",
      arguments: z.object({
        all: z.boolean().default(true).describe(
          "Include stopped containers (`docker ps -a`). Defaults to true: a crashed container is usually the one you are looking for.",
        ),
      }),
      execute: async (args: { all: boolean }, context: Context) => {
        const g = context.globalArgs;
        const command = psCommand(args.all);
        // @ts-ignore - Deno is provided by the swamp extension runtime
        const proc = new Deno.Command("ssh", {
          args: sshArgs(g.sshHost, g.sshUser, command, {
            strictHostKeyChecking: g.strictHostKeyChecking,
            knownHostsFile: g.knownHostsFile,
          }),
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        });
        const out = await proc.output();
        const stdout = new TextDecoder().decode(out.stdout);
        if (out.code !== 0) {
          const stderr = new TextDecoder().decode(out.stderr);
          throw new Error(
            `ssh ${g.sshUser}@${g.sshHost} docker ps failed (exit ${out.code}): ${
              stderr.trim().slice(-400)
            }`,
          );
        }
        const containers = parsePs(stdout);
        // Empty is not a pass: a reachable Docker host always lists at least
        // the containers it runs, and an empty result more likely means the
        // command printed nothing we could parse.
        if (containers.length === 0 && stdout.trim() !== "") {
          throw new Error(
            "docker ps returned output but no row parsed; refusing to report an empty host",
          );
        }
        const result = {
          host: g.sshHost,
          includeStopped: args.all,
          count: containers.length,
          running: containers.filter((c) => c.state === "running").length,
          containers,
          timestamp: new Date().toISOString(),
        };
        context.logger.info("{host}: {count} containers, {running} running", {
          host: g.sshHost,
          count: result.count,
          running: result.running,
        });
        await context.writeResource("containers", "containers", result);
        return result;
      },
    },
  },
};
