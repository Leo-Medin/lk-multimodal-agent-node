# Use an official Node.js runtime as a parent image
FROM node:18

# Set the working directory
WORKDIR /app

# Install pnpm globally
RUN npm install -g pnpm

# Copy package.json and pnpm-lock.yaml
COPY package.json pnpm-lock.yaml ./

# Install dependencies using pnpm
RUN pnpm install --frozen-lockfile

# Copy the rest of the application files
COPY . .

# To force Railway to use env variables
ARG LIVEKIT_URL
ARG LIVEKIT_API_KEY
ARG LIVEKIT_API_SECRET

ENV LIVEKIT_URL=$LIVEKIT_URL
ENV LIVEKIT_API_KEY=$LIVEKIT_API_KEY
ENV LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET

# Build the TypeScript code
RUN pnpm build

# Expose the health check port (optional)
EXPOSE 8081

# Start the application
# CMD ["pnpm", "start"]
# CMD ["node", "src/agent.js", "start"]
# below is the command that works
CMD ["pnpm", "dev"]
