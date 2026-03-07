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

## Temporarily disable Railway and run locally with your Next.js app

If you have an older version of this backend running on Railway and want your Next.js app to talk to a local instance instead, follow these steps:

1. Pause your Railway deployment (temporary)
   - Web UI: Open your project in Railway → Environments → select the service running this backend → click Pause/Stop.
   - CLI (optional): If you use the Railway CLI, you can run `railway service pause` from the service directory. Refer to Railway docs for exact syntax per setup.
   - This prevents the remote instance from consuming events or conflicting with your local instance.

2. Prepare environment variables locally
   - Copy `.env.example` to `.env.local` and fill in values for your environment:
     - `LIVEKIT_URL`
     - `LIVEKIT_API_KEY`
     - `LIVEKIT_API_SECRET`
     - `OPENAI_API_KEY`
   - These are required for the agent to join your LiveKit server and operate normally.

3. Start the backend locally
   ```bash
   pnpm install
   pnpm build
   pnpm start    # or: pnpm dev
   ```
   Notes:
   - This backend is a LiveKit Agent process; it does not expose a traditional REST API. Your frontend connects to LiveKit, and the agent joins the same room to interact.
   - Make sure your local machine can reach the LiveKit server specified by `LIVEKIT_URL` (cloud or local).

4. Point your Next.js app to the local setup
   - In your Next.js app, ensure that any environment variables referencing the “backend” or agent environment are set for local development. For example, in `.env.local` of your Next.js project:
     ```env
     # Example variables your Next.js app might use
     NEXT_PUBLIC_LIVEKIT_URL=http://localhost:7880   # or your cloud URL if you’re not running LiveKit locally
     NEXT_PUBLIC_ENV=local
     ```
   - If your Next.js app previously called an HTTP endpoint on Railway, switch that base URL to `http://localhost:<your_port>` (only if you added custom HTTP endpoints). By default, this repo does not serve HTTP routes.

5. Verify end-to-end
   - Start your Next.js dev server (`pnpm dev` or `next dev`).
   - Ensure your app creates/join rooms on the same LiveKit server as the agent.
   - With the Railway instance paused and the local agent running, the interactions should route through your local backend agent process.

6. Re-enable Railway when done (optional)
   - Resume the service in Railway when you want to switch back to the hosted backend.

## Object storage layout

```text
kb/
  {tenantId}/
    active.json              ← pointer: { versionId, publishedAt }
    versions/
      {ISO-timestamp}.json   ← full TenantKB snapshot
    uploads/
      {ISO-timestamp}-{filename}  ← raw CSV upload (if any)
```
