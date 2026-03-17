# lk-multimodal-agent-node

Multi-tenant voice assistant backend built on [LiveKit Agents](https://github.com/livekit/agents-js) and the OpenAI Realtime API.

Each tenant gets their own Knowledge Base and AI configuration stored in AWS S3. The agent loads per-tenant config and KB at session start — no restarts needed when content changes.

## Stack

- **LiveKit Agents** (Node.js) — real-time voice session management
- **OpenAI Realtime API** — speech-to-speech with function calling
- **AWS S3** — KB and tenant config storage
- **Nodemailer** — appointment email delivery

## Dev Setup

```bash
pnpm install
cp .env.example .env.local
```

Fill in `.env.local`:

```env
LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
OPENAI_API_KEY=

EMAIL=
EMAIL_PASS=

AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
KB_S3_BUCKET=your-bucket-name
KB_S3_REGION=eu-central-1
```

```bash
pnpm build
node dist/agent.js dev
```

This agent requires a frontend application to communicate with.

## Multi-tenant design

The room name encodes the tenant: `{tenantId}-room-{random}` (e.g. `autolife-room-1234`). At session start the agent:

1. Extracts `tenantId` from the room name.
2. Loads `kb/{tenantId}/config.json` from S3 → AI instructions + office email.
3. Loads `kb/{tenantId}/kb.json` from S3 → Knowledge Base (company info, hours, services, prices, FAQ).

AI instructions and office email are fully configurable per tenant via the `lk-kb-admin` Settings page — no code changes needed.

## S3 layout

```
tenants/
  registry.json                    ← tenant credentials (managed by lk-kb-admin)

kb/
  {tenantId}/
    kb.json                        ← active Knowledge Base (TenantKB)
    config.json                    ← {instructions, officeEmail}
    versions/
      {unix-ms}.json               ← auto-saved backups (managed by lk-kb-admin)
    excel-uploads/
      {unix-ms}.xlsx               ← raw Excel uploads (managed by lk-kb-admin)
```

### kb.json

Full `TenantKB` object — company info, hours, services, brand groups, prices, FAQ. Published by `lk-kb-admin`.

### config.json

```json
{
  "instructions": "You are the voice assistant for ...",
  "officeEmail": "office@example.com"
}
```

`instructions` is used as the OpenAI Realtime system prompt. `officeEmail` is the recipient for appointment confirmation emails.

## Agent capabilities

### `searchDocs`

Searches the in-memory Knowledge Index built from the tenant's KB. Supports:
- BM25-style TF-IDF scoring with title boost and exact phrase bonus
- Brand group-aware scoring (penalises irrelevant brand context chunks)
- Automatic translation of non-English queries to English before search

Results are returned as ranked passages with source citations, which are also forwarded to the frontend via the LiveKit data channel.

### `bookAppointment`

Collects appointment details step by step (name, phone, car model, year, reason, preferred date). Validates Cyprus local (8-digit) and E.164 international phone numbers. Reads details back for user confirmation.

### `confirmAppointment`

On user confirmation, sends an appointment email via Nodemailer to the tenant's `officeEmail` from S3 config.

## Session behaviour

- Tenant resolved from room name prefix before the participant joins.
- KB and config loaded from S3 once per session; no polling.
- Language detection from user speech (English / Greek / Russian); non-English queries translated to English for KB search.

### Session termination

Sessions are normally ended by the **frontend** on inactivity:

| Mode | Frontend inactivity timeout |
|---|---|
| Voice | 15 seconds of silence |
| Text | 5 minutes of no input |

The **backend** enforces a hard 3-minute cap as a fallback for voice sessions — in case the frontend fails to disconnect (network drop, browser crash, etc.). On expiry, the agent notifies the frontend via the LiveKit data channel (`{ type: "session_timeout" }`) before disconnecting.

## Related projects

- `lk-kb-admin` — admin UI for managing KB and tenant config in S3
- `lk-voice-assistant-frontend` — consumer-facing voice UI
