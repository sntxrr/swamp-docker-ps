import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
} from "jsr:@std/assert@1";
import {
  model,
  parsePorts,
  parsePs,
  PS_FORMAT,
  psCommand,
  sshArgs,
} from "./docker_ps.ts";

// --- the command itself: the read-only boundary --------------------------

Deno.test("psCommand never asks for labels, mounts or the whole object", () => {
  for (const all of [true, false]) {
    const cmd = psCommand(all);
    assert(cmd.startsWith("docker ps"));
    assertFalse(cmd.includes(".Labels"));
    assertFalse(cmd.includes(".Mounts"));
    assertFalse(cmd.includes("{{json .}}"));
    assertFalse(/inspect|exec|\brm\b|stop|kill|restart/.test(cmd));
  }
});

Deno.test("psCommand toggles -a only", () => {
  assert(psCommand(true).startsWith("docker ps -a --no-trunc --format"));
  assert(psCommand(false).startsWith("docker ps --no-trunc --format"));
});

Deno.test("the format template contains no single quote to break out of", () => {
  assertFalse(PS_FORMAT.includes("'"));
});

Deno.test("the type exposes exactly one method, ps", () => {
  assertEquals(Object.keys(model.methods), ["ps"]);
});

// --- parsePorts ------------------------------------------------------------

Deno.test("parsePorts reads published IPv4 and IPv6 bindings", () => {
  assertEquals(
    parsePorts("0.0.0.0:9091->9091/tcp, [::]:9091->9091/tcp"),
    [
      {
        hostIp: "0.0.0.0",
        hostPort: "9091",
        containerPort: "9091",
        protocol: "tcp",
      },
      {
        hostIp: "::",
        hostPort: "9091",
        containerPort: "9091",
        protocol: "tcp",
      },
    ],
  );
});

Deno.test("parsePorts keeps exposed-only ports without a host side", () => {
  assertEquals(parsePorts("9090/tcp"), [
    { hostIp: null, hostPort: null, containerPort: "9090", protocol: "tcp" },
  ]);
});

Deno.test("parsePorts keeps ranges and udp, and skips junk", () => {
  assertEquals(parsePorts("127.0.0.1:8000-8001->8000-8001/udp, garbage, "), [
    {
      hostIp: "127.0.0.1",
      hostPort: "8000-8001",
      containerPort: "8000-8001",
      protocol: "udp",
    },
  ]);
  assertEquals(parsePorts(""), []);
});

// --- parsePs ---------------------------------------------------------------

const line = (o: Record<string, unknown>) => JSON.stringify(o);

Deno.test("parsePs rebuilds rows from named fields only", () => {
  const out = [
    line({
      id: "0123456789abcdef0123",
      name: "web-preview",
      image: "example/web:1.2",
      state: "running",
      status: "Up 2 hours",
      ports: "9090/tcp, 0.0.0.0:9091->9091/tcp, [::]:9091->9091/tcp",
      createdAt: "2026-01-01 00:00:00 +0000 UTC",
      Labels: "com.example.secret=hunter2",
      env: "PASSWORD=hunter2",
    }),
    line({
      id: "fedcba9876543210",
      name: "api",
      image: "example/api:3",
      state: "exited",
      status: "Exited (1) 5 minutes ago",
      ports: "",
      createdAt: "2026-01-02 00:00:00 +0000 UTC",
    }),
  ].join("\n");
  const rows = parsePs(out);
  assertEquals(rows.map((r) => r.name), ["api", "web-preview"]);
  const web = rows[1];
  assertEquals(web.id, "0123456789ab");
  assertEquals(web.publishedHostPorts, ["9091/tcp"]);
  assertEquals(web.ports.length, 3);
  assertFalse(JSON.stringify(rows).includes("hunter2"));
  assertEquals(Object.keys(web).sort(), [
    "createdAt",
    "id",
    "image",
    "name",
    "ports",
    "publishedHostPorts",
    "state",
    "status",
  ]);
});

Deno.test("parsePs skips malformed lines and rows without an id", () => {
  const out = [
    "not json",
    "{broken",
    line({ name: "no-id" }),
    line({ id: "abc", name: "ok", ports: "" }),
  ].join("\n");
  assertEquals(parsePs(out).map((r) => r.name), ["ok"]);
});

Deno.test("parsePs treats non-string fields as empty", () => {
  const [row] = parsePs(line({ id: "abc", name: 7, ports: null }));
  assertEquals(row.name, "");
  assertEquals(row.ports, []);
});

// --- sshArgs ---------------------------------------------------------------

Deno.test("sshArgs keeps host key checking on and batch mode set", () => {
  const args = sshArgs("dockerhost.example", "ops", "docker ps");
  assert(args.includes("StrictHostKeyChecking=accept-new"));
  assert(args.includes("BatchMode=yes"));
  assertEquals(args.slice(-2), ["ops@dockerhost.example", "docker ps"]);
});

Deno.test("sshArgs passes a known_hosts override", () => {
  const args = sshArgs("h", "u", "c", { knownHostsFile: "/tmp/kh" });
  assert(args.includes("UserKnownHostsFile=/tmp/kh"));
});

Deno.test("ssh host and user refuse anything ssh could read as an option", async () => {
  const { SSH_HOST_RE, SSH_USER_RE } = await import("./docker_ps.ts");
  for (
    const ok of [
      "dockerhost",
      "host.example.com",
      "192.0.2.10",
      "[2001:db8::1]",
    ]
  ) {
    assert(SSH_HOST_RE.test(ok), ok);
  }
  for (const bad of ["-oProxyCommand=sh", "host name", "h;id", ""]) {
    assertFalse(SSH_HOST_RE.test(bad), bad);
  }
  assert(SSH_USER_RE.test("ops"));
  assertFalse(SSH_USER_RE.test("-l"));
  assertFalse(SSH_USER_RE.test("a b"));
});

// --- execute: ssh is stubbed, nothing leaves the test ----------------------

async function runPs(
  code: number,
  stdout: string,
  stderr = "",
  writes: unknown[] = [],
): Promise<{ result: unknown; writes: unknown[]; argv: string[] }> {
  let argv: string[] = [];
  const real = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    constructor(cmd: string, opts: { args: string[] }) {
      argv = [cmd, ...opts.args];
    }
    output() {
      const enc = new TextEncoder();
      return Promise.resolve({
        code,
        stdout: enc.encode(stdout),
        stderr: enc.encode(stderr),
      });
    }
  };
  try {
    const result = await model.methods.ps.execute({ all: true }, {
      globalArgs: {
        sshHost: "host.example.com",
        sshUser: "ops",
        strictHostKeyChecking: "accept-new",
      },
      logger: { info: () => {} },
      writeResource: (_r, _i, attrs) => {
        writes.push(attrs);
        return Promise.resolve();
      },
    });
    return { result, writes, argv };
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = real;
  }
}

Deno.test("ps writes the parsed listing once", async () => {
  const line = JSON.stringify({
    id: "0123456789abcdef",
    name: "web",
    image: "nginx:1",
    state: "running",
    status: "Up 2 hours",
    ports: "0.0.0.0:8080->80/tcp",
    createdAt: "2026-10-01 00:00:00 +0000 UTC",
  });
  const { writes, argv } = await runPs(0, line + "\n");
  assertEquals(argv[0], "ssh");
  assert(argv.includes("ops@host.example.com"));
  assertEquals(writes.length, 1);
  const w = writes[0] as { count: number; running: number };
  assertEquals(w.count, 1);
  assertEquals(w.running, 1);
});

Deno.test("ps throws on ssh failure and writes nothing", async () => {
  const writes: unknown[] = [];
  await assertRejects(
    () => runPs(255, "", "Permission denied (publickey).", writes),
    Error,
    "exit 255",
  );
  assertEquals(writes.length, 0);
});

Deno.test("ps refuses output it cannot parse rather than report an empty host", async () => {
  const writes: unknown[] = [];
  await assertRejects(
    () => runPs(0, "Cannot connect to the Docker daemon\n", "", writes),
    Error,
    "no row parsed",
  );
  assertEquals(writes.length, 0);
});
