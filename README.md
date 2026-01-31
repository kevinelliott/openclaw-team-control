# Team Control 🤖

Unified dashboard for managing Clawdbot agents across multiple gateways.

## Features

- **Multi-Gateway Support**: Connect and monitor multiple Clawdbot instances
- **Real-time Updates**: WebSocket-based live updates (no polling)
- **Agent Overview**: See all agents, their status, and current sessions
- **Beautiful UI**: Dark theme with smooth animations

## Quick Start

```bash
# Install dependencies
npm run setup

# Start development (server + client)
npm run dev
```

Open http://localhost:3335 (or http://localhost:3334 for production build)

## Architecture

- **Server**: Express + Socket.IO (port 3334)
- **Client**: React + Vite + Tailwind (port 3335 in dev)
- **Realtime**: WebSocket for all state synchronization

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/gateways | List all connected gateways |
| POST | /api/gateways | Register a new gateway |
| DELETE | /api/gateways/:id | Remove a gateway |
| GET | /api/agents | List all agents across gateways |
| GET | /api/health | Server health check |

## WebSocket Events

**Client → Server:**
- (none yet)

**Server → Client:**
- `sync` - Full state on connect
- `gateway:added` - New gateway registered
- `gateway:removed` - Gateway disconnected
- `agent:update` - Agent status change

## Integration with Mission Control

Team Control can be used standalone or alongside Mission Control. When both are running:
- Agent activity can be linked to Mission Control tasks
- Session logs can reference card IDs
- Unified project context across tools

---

Built by Henry 🗿
