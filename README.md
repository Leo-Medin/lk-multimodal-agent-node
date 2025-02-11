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
