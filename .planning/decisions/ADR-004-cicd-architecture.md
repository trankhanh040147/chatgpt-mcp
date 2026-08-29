# ADR-004: CI/CD architecture (4-layer, verified artifact release)

**Status:** ACCEPTED  
**Date:** 2026-08-29  
**Context:** [0.6 CI/CD plan](../active/0.6-cicd.md) · PR `feat/cicd`

## Decision

Adopt **4-layer CI/CD**: PR CI (quality + compat + dependency review), security automation (Dependabot + weekly audit + CodeQL Default Setup), Live E2E on protected self-hosted Mac, Release CD (prepare artifact → approval → publish same `.tgz` via OIDC).

See [0.6 CI/CD plan](../active/0.6-cicd.md) for workflow details and manual GitHub/npm setup.

## Key invariants

1. **Test the package, not just the source** — `npm pack` → install tarball → CLI smoke → `npm publish ./…tgz`
2. **Self-hosted Mac = production credentials** — `workflow_dispatch` only, trusted ref, never `pull_request`
3. **SHA-pinned Actions** — no mutable `@v6` tags in workflows
4. **Split release jobs** — unprivileged `prepare` → privileged `publish` (environment `npm`)
5. **`files: ["dist"]`** — npm includes README/LICENSE automatically

## Registry provenance vs release attestation

| Artifact | Mechanism |
|----------|-----------|
| npm package | Automatic provenance via Trusted Publishing |
| GitHub Release `.tgz` | `actions/attest-build-provenance` + SHA256 sidecar |

## Alternatives rejected

E2E in PR CI, `NPM_TOKEN`, blocking weekly audit on PR, single-job release with rebuild, Docker deploy.
