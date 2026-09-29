---
title: Apple container build fails with MAP FAILED; fix with SKIP_CAPACITY=6G
date: 2026-09-25
category: build-errors
module: container image build
problem_type: build_error
component: infrastructure
symptoms:
  - "container build fails at RUN make clean && make STAGE=$STAGE with ERROR (MAP FAILED): Cannot allocate memory"
  - make fails at /work/compiler/stage0/lib/libstd.sklib with Error 41
root_cause: config_error
resolution_type: config_change
severity: medium
tags: [apple-container, skip-capacity, mmap, arm64]
---

# Apple container build fails with MAP FAILED; fix with SKIP_CAPACITY=6G

## Problem

Building the `skip` image (root Dockerfile `skip` target, tag `skiplabs/skip:latest`) with Apple's `container` CLI v1.1.0 on macOS arm64 fails during the compiler bootstrap because the Skip runtime's default 16 GB mmap reservation exceeds the Apple container builder VM's virtual-memory limit.

## Symptoms

- Prereqs on the host (48 GB RAM, 18 CPUs): `container system kernel set --recommended` (the kata kernel was unconfigured for arm64) and `container builder start --cpus 8 --memory 16G`.
- Build command `container build --platform linux/arm64 --progress plain -f Dockerfile -t skiplabs/skip:latest .` fails at the bootstrap step `RUN make clean && make STAGE=$STAGE` (Dockerfile:26).
- Failure signature: `ERROR (MAP FAILED): Cannot allocate memory`, then `make[2]: *** [Makefile:82: /work/compiler/stage0/lib/libstd.sklib] Error 41`.
- Host RAM is misleading here: the failure is a virtual-memory reservation limit inside the builder VM, not physical RAM exhaustion.

## What Didn't Work

- The default build without any capacity override: relying on the Dockerfile's empty default (`ARG SKIP_CAPACITY=` / `ENV SKIP_CAPACITY=$SKIP_CAPACITY`, Dockerfile:17-18), which preserves the runtime's own 16 GB default for local dev builds (Dockerfile:14-16), reproduces the MAP FAILED failure under the Apple container builder VM.
- This is the genuine technical dead end — no reduced-memory build path was available without explicitly capping the reservation. (No repo code was changed; this was purely an invocation-level issue.)

## Solution

Rebuild with the documented capacity override, using CI's constrained-host value of 6G:

```sh
container build --platform linux/arm64 --progress plain \
  -f Dockerfile --build-arg SKIP_CAPACITY=6G \
  -t skiplabs/skip:latest .
```

Builder/kernel prereqs (one time):

```sh
container system kernel set --recommended
container builder start --cpus 8 --memory 16G
```

This build succeeds with all steps DONE and no MAP FAILED. Verified via `container image list` showing `skiplabs/skip:latest`, and:

```sh
container run --rm skiplabs/skip:latest sh -c 'which skc skargo skfmt; echo SKIP_CAPACITY=$SKIP_CAPACITY'
```

showing all three toolchain binaries present and `SKIP_CAPACITY=6G` baked in.

Running the toolchain also needs explicit run memory: in this session, a plain `container run --rm skiplabs/skip:latest ...` (default memory) still hit MAP FAILED at runtime, while `container run --rm -m 12G ...` progressed past it (Apple container-CLI behavior, not repo-defined).

## Why This Works

The root Dockerfile explicitly documents `--build-arg SKIP_CAPACITY=<value>` "to fit the build host's memory budget", with the empty default preserving "the runtime's own 16 GB default for local dev builds" (Dockerfile:14-16). `bin/docker_build.sh` documents the same `SKIP_CAPACITY` env var as "capping the runtime's mmap reservation" and "required on hosts that enforce virtual memory limits (e.g. gen2 CI builders)" (bin/docker_build.sh:25-28), and forwards it to the `skiplang`, `skip`, `skiplang-bin-builder`, and `skipruntime` bake targets (bin/docker_build.sh:276-286).

Passing `SKIP_CAPACITY=6G` therefore lowers the runtime's mmap reservation below the Apple container builder VM's virtual-memory ceiling, so the bootstrap `make` step (Dockerfile:26) can reserve its address space and complete. This mirrors how constrained CI builders already cope: `.circleci/base.yml` sets `SKIP_CAPACITY` to 3G/6G/12G depending on job size (`check-ts` at 3G, .circleci/base.yml:41; `skdb`, `skdb-wasm`, `skipruntime`, and `skipruntime-bun` at 6G, .circleci/base.yml:93,107,180,224; `compiler` at 12G, .circleci/base.yml:69). The 6G choice is CI's established constrained-host value, applied here to the Apple container builder VM. Similarly, `container run -m 12G` raises the runtime container's own memory ceiling past the same reservation failure (observed in this session).

## Prevention

- Always pass `SKIP_CAPACITY` when building `skip`/`skiplang` images under Apple's `container` CLI, whose builder VM enforces a virtual-memory limit well below the runtime's 16 GB default.
- Use CI's 6G constrained-host value (.circleci/base.yml:93,107,180,224) as the starting point; escalate toward 12G (the `compiler` job value, .circleci/base.yml:69) only if the build still fails.
- Allocate run memory explicitly with `container run -m` (e.g. `-m 12G`) whenever executing the Skip toolchain inside an Apple container, since the default run memory reproduces the same MAP FAILED failure at runtime.

## Related Issues

- [SkipLabs/skip#1189](https://github.com/SkipLabs/skip/issues/1189) — Skip runtime: no env-var for heap capacity, and --capacity is rejected by CLI parsers (closed; background on capacity configurability, distinct from this builder-VM failure).
