# Voice assistant with OpenAI agent and enabled web search (backend).

Based example of a multimodal voice agent using LiveKit and the Node.js [Agents Framework](https://github.com/livekit/agents-js).

## Dev Setup

Clone the repository and install dependencies:

```bash
pnpm install
```

Set up the environment by copying `.env.example` to `.env.local` and filling in the required values:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `OPENAI_API_KEY`

You can also do this automatically using the LiveKit CLI:

```bash
lk app env
```

To run the agent, first build the TypeScript project, then execute the output with the `dev` or `start` commands:
    
```bash
pnpm build
node dist/agent.js dev # see agents-js for more info on subcommands
```

This agent requires a frontend application to communicate with. 

## Knowledge Base (KB) storage contract (AWS S3)

This service **consumes** a published tenant KB from S3 (or any S3-compatible storage).
KB management/publishing is expected to happen in your Next.js app (control plane).

### Key layout

All keys are relative to:

- `KB_S3_PREFIX` (default: `kb/`)
- `TENANT_ID` (single-tenant deployment for this agent process)

Keys:

- Active pointer:
  - `{prefix}{tenantId}/active.json`
- Immutable snapshot:
  - `{prefix}{tenantId}/versions/{versionId}.json`

At runtime the agent only needs to know “what KB is active”. Instead of overwriting a large JSON file in-place, we:
1) upload a new immutable snapshot under `versions/`, and then
2) atomically switch `active.json` to point to it.

Benefits:
- `active.json` is the only file the agent needs to read first (small & fast)
- `versions/` gives you rollback for free (just repoint `active.json`)
- `uploads/` keeps raw user files for audit/reprocessing

### active.json (pointer)

`{ "versionId": "2026-03-07T10:23:00.000Z", "publishedAt": "2026-03-07T10:23:00.000Z" }`
- `versionId` must match a file in `{prefix}{tenantId}/versions/{versionId}.json`.
- `publishedAt` is optional metadata (useful for UI/logging).

```text
kb/
  {tenantId}/
    active.json              ← pointer: { versionId, publishedAt }
    versions/
      {ISO-timestamp}.json   ← full TenantKB snapshot
    uploads/
      {ISO-timestamp}-{filename}  ← raw CSV upload (if any)
```
