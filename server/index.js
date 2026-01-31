/**
 * Team Control Server
 * 
 * Unified dashboard for managing Clawdbot agents across multiple gateways.
 * Uses WebSocket for realtime updates and polls gateways for health.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const GatewayManager = require('./gateway-manager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE'] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client/dist')));

// Initialize gateway manager
const gatewayManager = new GatewayManager();

// Forward gateway manager events to WebSocket clients
gatewayManager.on('gateway:added', (gw) => io.emit('gateway:added', gw));
gatewayManager.on('gateway:removed', (data) => io.emit('gateway:removed', data));
gatewayManager.on('gateway:update', (gw) => io.emit('gateway:update', gw));
gatewayManager.on('agent:update', (agent) => io.emit('agent:update', agent));
gatewayManager.on('agent:removed', (data) => io.emit('agent:removed', data));

// === REST API ===

// Gateway endpoints
app.post('/api/gateways', (req, res) => {
  const { url, name, token } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const gateway = gatewayManager.addGateway({ url, name, token });
    res.json(gateway);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gateways', (req, res) => {
  res.json(gatewayManager.getGateways());
});

app.get('/api/gateways/:id', (req, res) => {
  const gateways = gatewayManager.getGateways();
  const gateway = gateways.find(g => g.id === req.params.id);
  
  if (gateway) {
    res.json(gateway);
  } else {
    res.status(404).json({ error: 'Gateway not found' });
  }
});

app.delete('/api/gateways/:id', (req, res) => {
  const success = gatewayManager.removeGateway(req.params.id);
  
  if (success) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Gateway not found' });
  }
});

// Trigger discovery
app.post('/api/gateways/discover', async (req, res) => {
  try {
    const discovered = await gatewayManager.discoverLocal();
    res.json({ discovered: discovered.length, gateways: discovered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Agent endpoints
app.get('/api/agents', (req, res) => {
  const agents = gatewayManager.getAgents();
  
  // Optional filter by gateway
  if (req.query.gatewayId) {
    res.json(agents.filter(a => a.gatewayId === req.query.gatewayId));
  } else {
    res.json(agents);
  }
});

app.get('/api/agents/:id', (req, res) => {
  const agents = gatewayManager.getAgents();
  const agent = agents.find(a => a.id === req.params.id);
  
  if (agent) {
    res.json(agent);
  } else {
    res.status(404).json({ error: 'Agent not found' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    type: 'team-control',
    uptime: process.uptime(),
    gateways: gatewayManager.getGateways().length,
    agents: gatewayManager.getAgents().length,
    timestamp: new Date().toISOString()
  });
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
  const gateways = gatewayManager.getGateways();
  const agents = gatewayManager.getAgents();
  
  res.json({
    gateways: {
      total: gateways.length,
      online: gateways.filter(g => g.status === 'online').length,
      offline: gateways.filter(g => g.status === 'offline' || g.status === 'disconnected').length,
      error: gateways.filter(g => g.status === 'error').length
    },
    agents: {
      total: agents.length,
      active: agents.filter(a => a.status === 'active').length,
      idle: agents.filter(a => a.status === 'idle').length,
      sessions: agents.reduce((acc, a) => acc + (a.sessions?.length || 0), 0)
    }
  });
});

// === WebSocket connections ===
io.on('connection', (socket) => {
  console.log('👤 Client connected:', socket.id);
  
  // Send current state on connect
  socket.emit('sync', {
    gateways: gatewayManager.getGateways(),
    agents: gatewayManager.getAgents()
  });
  
  // Handle client commands
  socket.on('refresh', () => {
    socket.emit('sync', {
      gateways: gatewayManager.getGateways(),
      agents: gatewayManager.getAgents()
    });
  });

  socket.on('discover', async () => {
    const discovered = await gatewayManager.discoverLocal();
    socket.emit('discovery:complete', { discovered: discovered.length, gateways: discovered });
  });

  socket.on('gateway:update', ({ id, name, token }) => {
    const success = gatewayManager.updateGateway(id, { name, token });
    if (success) {
      console.log(`✏️ Gateway ${id} updated`);
    }
  });

  // Agent actions - get session history
  socket.on('agent:getHistory', async ({ agentId, gatewayId }, callback) => {
    if (typeof callback !== 'function') return;
    
    try {
      const agent = gatewayManager.getAgents().find(a => a.id === agentId);
      if (!agent) {
        return callback({ error: 'Agent not found', history: [] });
      }
      
      // Try to get history via gateway protocol
      const result = await gatewayManager.sendRequest(gatewayId, 'sessions.history', {
        sessionKey: agent.sessionKey,
        limit: 50
      });
      
      callback({ history: result?.messages || [] });
    } catch (err) {
      console.log(`Failed to get history for ${agentId}:`, err.message);
      callback({ error: err.message, history: [] });
    }
  });

  // Agent actions - terminate
  socket.on('agent:terminate', async ({ agentId, gatewayId }, callback) => {
    if (typeof callback !== 'function') return;
    
    try {
      const agent = gatewayManager.getAgents().find(a => a.id === agentId);
      if (!agent) {
        return callback({ error: 'Agent not found' });
      }
      
      // Send delete request to gateway (gateway expects 'key' not 'sessionKey')
      await gatewayManager.sendRequest(gatewayId, 'sessions.delete', {
        key: agent.sessionKey
      });
      
      callback({ success: true });
    } catch (err) {
      console.log(`Failed to terminate ${agentId}:`, err.message);
      callback({ error: err.message });
    }
  });

  // Agent actions - restart
  socket.on('agent:restart', async ({ agentId, gatewayId }, callback) => {
    if (typeof callback !== 'function') return;
    
    try {
      const agent = gatewayManager.getAgents().find(a => a.id === agentId);
      if (!agent) {
        return callback({ error: 'Agent not found' });
      }
      
      // Restart = send a message to wake/restart the session
      await gatewayManager.sendRequest(gatewayId, 'sessions.send', {
        sessionKey: agent.sessionKey,
        message: '/restart'
      });
      
      callback({ success: true });
    } catch (err) {
      console.log(`Failed to restart ${agentId}:`, err.message);
      callback({ error: err.message });
    }
  });

  // Agent actions - pause/resume (not directly supported, but we can try)
  socket.on('agent:pause', async ({ agentId, gatewayId }, callback) => {
    if (typeof callback !== 'function') return;
    callback({ error: 'Pause not supported yet' });
  });

  socket.on('agent:resume', async ({ agentId, gatewayId }, callback) => {
    if (typeof callback !== 'function') return;
    callback({ error: 'Resume not supported yet' });
  });

  // Agent actions - refresh data
  socket.on('agent:refresh', async ({ agentId, gatewayId }, callback) => {
    if (typeof callback !== 'function') return;
    
    try {
      // Re-fetch sessions from gateway
      const result = await gatewayManager.sendRequest(gatewayId, 'sessions.list', {});
      callback({ success: true, sessions: result?.sessions?.length || 0 });
    } catch (err) {
      callback({ error: err.message });
    }
  });

  // Close individual session
  socket.on('session:close', async ({ sessionKey, gatewayId }, callback) => {
    if (typeof callback !== 'function') return;
    
    if (!sessionKey || !gatewayId) {
      return callback({ error: 'sessionKey and gatewayId required' });
    }
    
    try {
      // Gateway expects 'key' not 'sessionKey'
      await gatewayManager.sendRequest(gatewayId, 'sessions.delete', {
        key: sessionKey
      });
      callback({ success: true });
    } catch (err) {
      console.log(`Failed to close session ${sessionKey}:`, err.message);
      callback({ error: err.message });
    }
  });

  // Agent actions - send message
  socket.on('agent:sendMessage', async ({ agentId, gatewayId, message }, callback) => {
    if (!message) return;
    
    try {
      const agent = gatewayManager.getAgents().find(a => a.id === agentId);
      if (!agent) {
        if (typeof callback === 'function') callback({ error: 'Agent not found' });
        return;
      }
      
      await gatewayManager.sendRequest(gatewayId, 'sessions.send', {
        sessionKey: agent.sessionKey,
        message
      });
      
      if (typeof callback === 'function') callback({ success: true });
    } catch (err) {
      console.log(`Failed to send message to ${agentId}:`, err.message);
      if (typeof callback === 'function') callback({ error: err.message });
    }
  });
  
  socket.on('disconnect', () => {
    console.log('👋 Client disconnected:', socket.id);
  });
});

// Serve React app for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  gatewayManager.shutdown();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  gatewayManager.shutdown();
  server.close(() => process.exit(0));
});

// Get LAN IP for display
function getLanIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.internal || iface.family !== 'IPv4') continue;
      return iface.address;
    }
  }
  return 'localhost';
}

// Start server and initialize gateway manager
const PORT = process.env.PORT || 3335;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  const lanIP = getLanIP();
  console.log(`🚀 Team Control running on:`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://${lanIP}:${PORT}`);
  gatewayManager.init();
});
