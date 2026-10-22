# @sntxrr/docker-ps

A read-only container listing of a Docker host over SSH, narrow enough to hand
to an unattended triage agent.

## The problem it solves

When an alert fires about a service on a Docker host, the first questions are
"what is running there?" and "who holds port N?". The commands that answer
them are the wrong ones to give an agent:

- `docker inspect` returns every container's **environment**, which is where
  compose files keep database passwords and API tokens.
- `docker ps --format '{{json .}}'` includes the **Labels** field, whose values
  carry project paths and, on some stacks, configuration.
- `docker exec` runs as root inside the container.

This model runs `docker ps` with an explicit, per-field `--format` template
(ID, name, image, state, status, ports, created) and rebuilds each row from
those fields alone. A Docker version that adds a field cannot widen what leaves
the host.

## Method

| method | effect |
|---|---|
| `ps` | Read-only. Lists the host's containers, including stopped ones unless `all: false`. Writes the `containers` data instance. |

There is no other method, and nothing accepts a free-form command or format
string, so a model instance of this type exposes no write verb.

## Usage

```bash
swamp extension pull @sntxrr/docker-ps
swamp model create @sntxrr/docker-ps/host docker-host \
  --global-arg sshHost=dockerhost.example.com --global-arg sshUser=ops

swamp model method run docker-host ps --json
# who holds 9091?
swamp model method run docker-host ps --json \
  | jq '.. | objects | select(has("publishedHostPorts"))
        | select(any(.publishedHostPorts[]; . == "9091/tcp")) | .name'
```

## Output

Each container:

```json
{
  "id": "0123456789ab",
  "name": "web-preview",
  "image": "example/web:1.2",
  "state": "running",
  "status": "Up 2 hours",
  "createdAt": "2026-01-01 00:00:00 +0000 UTC",
  "ports": [
    { "hostIp": "0.0.0.0", "hostPort": "9091", "containerPort": "9091", "protocol": "tcp" },
    { "hostIp": null, "hostPort": null, "containerPort": "9090", "protocol": "tcp" }
  ],
  "publishedHostPorts": ["9091/tcp"]
}
```

An entry with no host side is exposed but not published.

## Global arguments

| argument | default | meaning |
|---|---|---|
| `sshHost` | (required) | The Docker host. |
| `sshUser` | `root` | Needs permission to run `docker ps`, nothing more. |
| `strictHostKeyChecking` | `accept-new` | `yes`, `accept-new` or `no`. `no` is never the default. |
| `knownHostsFile` | (unset) | Optional `UserKnownHostsFile` override. |

## Requirements

- `ssh` on the machine running swamp, with non-interactive (`BatchMode`) access
  to the host.
- The Docker CLI on the host.

## What it does not do

It does not inspect, exec, restart, stop or remove anything, and it does not
read logs. A user who can run `docker ps` on the host can usually do all of
those by other means; this model is the narrow tool, not a privilege boundary.
