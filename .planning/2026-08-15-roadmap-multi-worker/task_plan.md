# 0.2.0 Static Multi-Worker

**Status:** Design **locked (v3)** after two ChatGPT reviews. Ready to implement.

**Plan SSOT:** `~/.cursor/plans/0.2.0_multi-worker_7ac52882.plan.md`

## Goal

Static multi-worker: leases, heartbeats, fencing (dispatch + one nudge), dedicated status-api, separate CDP profiles, dual-worker evidence.

## Implementation order

1. Schema + offline migration  
2. Claim/renew/expire + instance_token CAS  
3. Dispatch fence then type; one-nudge fence  
4. status-api mode + reaper + Make/doctor  
5. Dual-profile E2E + crash matrix  
6. Docs / roadmap support snapshot  

## Non-goals

Auto-provision, auto-login, auto-approve, dynamic pool, shared-Chrome.
