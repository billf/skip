# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Skip toolchain

### Skip runtime

The native execution engine for Skip services, implemented in Skiplang and shipped as a shared library. At startup it reserves a large virtual address space for its heap, so hosts that cap virtual memory must configure that reservation down.

### SKIP_CAPACITY

The cap on the address space the Skip runtime reserves, set as a build argument or environment variable wherever the toolchain runs. Build tooling and CI lower it below the runtime default on hosts with virtual-memory limits; a host can have ample physical RAM and still fail with a map failure when the reservation exceeds the limit.
