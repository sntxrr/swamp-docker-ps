# swamp-docker-ps

A [swamp](https://github.com/systeminit/swamp) extension that lists a Docker
host's containers read-only over SSH: name, image, state, status, published
ports and creation time. No environment variables, no label values, and no
write method.

**The full documentation is [`extensions/models/README.md`](extensions/models/README.md)**,
which is also what ships with the extension.

## Install

```bash
swamp extension pull @sntxrr/docker-ps
```

## Development

```bash
~/.swamp/deno/deno check extensions/models/docker_ps.ts
~/.swamp/deno/deno lint extensions/models/
~/.swamp/deno/deno test extensions/models/
```
