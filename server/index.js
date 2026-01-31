const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client/dist')));

// In-memory gateway registry (will persist to file later)
const gateways = new Map();
const agents = new Map();

// Gateway registration
app.post('/api/gateways', (req, res) => {
  const { url, name, token } = req.body;
  const id = `gw-${Date.now().toString(36)}`;
  const gateway = { id, url, name, token, status: 'connecting', connectedAt: new Date().toISOString(), agents: [] };
  gateways.set(id, gateway);
  io.emit('gateway:added', gateway);
  res.json(gateway);
});

app.get('/api/gateways', (req, res) => {
  res.json(Array.from(gateways.values()));
});

app.delete('/api/gateways/:id', (req, res) => {
  const { id } = req.params;
  if (gateways.has(id)) {
    gateways.delete(id);
    io.emit('gateway:removed', { id });
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Gateway not found' });
  }
});

// Agents endpoint (aggregated from all gateways)
app.get('/api/agents', (req, res) => {
  res.json(Array.from(agents.values()));
});

// WebSocket connections for realtime updates
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Send current state on connect
  socket.emit('sync', {
    gateways: Array.from(gateways.values()),
    agents: Array.from(agents.values())
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), gateways: gateways.size, agents: agents.size });
});

// Serve React app for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});

const PORT = process.env.PORT || 3334;
server.listen(PORT, () => {
  console.log(`🚀 Team Control running on http://localhost:${PORT}`);
});
