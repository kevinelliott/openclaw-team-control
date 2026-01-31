import { useState, useEffect, useCallback } from 'react'
import { io } from 'socket.io-client'
import { Server, Bot, Activity, Plus, Settings, RefreshCw, Wifi, WifiOff, Trash2, Search, Clock, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'

const socket = io({ autoConnect: true })

function App() {
  const [gateways, setGateways] = useState([])
  const [agents, setAgents] = useState([])
  const [connected, setConnected] = useState(false)
  const [showAddGateway, setShowAddGateway] = useState(false)
  const [discovering, setDiscovering] = useState(false)

  useEffect(() => {
    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))
    
    socket.on('sync', (data) => {
      setGateways(data.gateways || [])
      setAgents(data.agents || [])
    })
    
    socket.on('gateway:added', (gw) => {
      setGateways(prev => {
        if (prev.some(g => g.id === gw.id)) return prev
        return [...prev, gw]
      })
    })
    
    socket.on('gateway:removed', ({ id }) => {
      setGateways(prev => prev.filter(g => g.id !== id))
      setAgents(prev => prev.filter(a => a.gatewayId !== id))
    })
    
    socket.on('gateway:update', (gw) => {
      setGateways(prev => prev.map(g => g.id === gw.id ? gw : g))
    })
    
    socket.on('agent:update', (agent) => {
      setAgents(prev => {
        const idx = prev.findIndex(a => a.id === agent.id)
        if (idx >= 0) return [...prev.slice(0, idx), agent, ...prev.slice(idx + 1)]
        return [...prev, agent]
      })
    })
    
    socket.on('agent:removed', ({ id }) => {
      setAgents(prev => prev.filter(a => a.id !== id))
    })

    socket.on('discovery:complete', ({ discovered, gateways: newGateways }) => {
      setDiscovering(false)
    })
    
    return () => {
      socket.off('connect')
      socket.off('disconnect')
      socket.off('sync')
      socket.off('gateway:added')
      socket.off('gateway:removed')
      socket.off('gateway:update')
      socket.off('agent:update')
      socket.off('agent:removed')
      socket.off('discovery:complete')
    }
  }, [])

  const addGateway = async (data) => {
    await fetch('/api/gateways', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
    setShowAddGateway(false)
  }

  const removeGateway = async (id) => {
    if (!confirm('Remove this gateway?')) return
    await fetch(`/api/gateways/${id}`, { method: 'DELETE' })
  }

  const discoverGateways = () => {
    setDiscovering(true)
    socket.emit('discover')
    // Timeout fallback
    setTimeout(() => setDiscovering(false), 10000)
  }

  const refresh = () => socket.emit('refresh')

  return (
    <div className="min-h-screen flex flex-col bg-bg-dark">
      <Header 
        connected={connected} 
        onAddGateway={() => setShowAddGateway(true)} 
        onDiscover={discoverGateways}
        onRefresh={refresh}
        discovering={discovering}
      />
      <main className="flex-1 p-6">
        {gateways.length === 0 ? (
          <EmptyState 
            onAdd={() => setShowAddGateway(true)} 
            onDiscover={discoverGateways}
            discovering={discovering}
          />
        ) : (
          <div className="space-y-8">
            <StatsBar gateways={gateways} agents={agents} />
            <GatewayGrid gateways={gateways} agents={agents} onRemove={removeGateway} />
          </div>
        )}
      </main>
      {showAddGateway && (
        <AddGatewayModal onClose={() => setShowAddGateway(false)} onSubmit={addGateway} />
      )}
    </div>
  )
}

function Header({ connected, onAddGateway, onDiscover, onRefresh, discovering }) {
  return (
    <header className="bg-bg-card border-b border-border-default px-6 py-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="bg-gradient-to-r from-blue-500 to-purple-600 p-2 rounded-lg">
          <Bot className="w-6 h-6 text-white" />
        </div>
        <div>
          <h1 className="text-xl font-bold">Team Control</h1>
          <p className="text-text-secondary text-sm">Clawdbot Agent Dashboard</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 text-sm mr-4">
          {connected ? (
            <Wifi className="w-4 h-4 text-green-400" />
          ) : (
            <WifiOff className="w-4 h-4 text-red-400" />
          )}
          <span className="text-text-secondary">{connected ? 'Connected' : 'Disconnected'}</span>
        </div>
        <button 
          onClick={onRefresh}
          className="p-2 text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded-lg transition-colors"
          title="Refresh"
        >
          <RefreshCw className="w-5 h-5" />
        </button>
        <button 
          onClick={onDiscover}
          disabled={discovering}
          className="flex items-center gap-2 px-3 py-2 text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded-lg transition-colors disabled:opacity-50"
          title="Auto-discover gateways"
        >
          {discovering ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Search className="w-4 h-4" />
          )}
          <span className="text-sm">Discover</span>
        </button>
        <button 
          onClick={onAddGateway} 
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" /> Add Gateway
        </button>
      </div>
    </header>
  )
}

function StatsBar({ gateways, agents }) {
  const onlineGateways = gateways.filter(g => g.status === 'online').length
  const activeAgents = agents.filter(a => a.status === 'active').length
  const totalSessions = agents.reduce((acc, a) => acc + (a.sessions?.length || 0), 0)
  
  return (
    <div className="grid grid-cols-4 gap-4">
      <StatCard 
        label="Gateways" 
        value={`${onlineGateways}/${gateways.length}`} 
        icon={<Server className="w-5 h-5" />} 
        color="blue"
        subtitle={onlineGateways === gateways.length ? 'All online' : `${gateways.length - onlineGateways} offline`}
      />
      <StatCard 
        label="Total Agents" 
        value={agents.length} 
        icon={<Bot className="w-5 h-5" />} 
        color="purple" 
      />
      <StatCard 
        label="Active" 
        value={activeAgents} 
        icon={<Activity className="w-5 h-5" />} 
        color="green" 
      />
      <StatCard 
        label="Sessions" 
        value={totalSessions} 
        icon={<RefreshCw className="w-5 h-5" />} 
        color="amber" 
      />
    </div>
  )
}

function StatCard({ label, value, icon, color, subtitle }) {
  const colors = {
    blue: 'from-blue-500/20 to-blue-600/10 text-blue-400',
    purple: 'from-purple-500/20 to-purple-600/10 text-purple-400',
    green: 'from-green-500/20 to-green-600/10 text-green-400',
    amber: 'from-amber-500/20 to-amber-600/10 text-amber-400'
  }
  return (
    <div className={`card bg-gradient-to-br ${colors[color]}`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-text-secondary text-sm">{label}</p>
          <p className="text-3xl font-bold mt-1">{value}</p>
          {subtitle && <p className="text-xs text-text-muted mt-1">{subtitle}</p>}
        </div>
        <div className="opacity-60">{icon}</div>
      </div>
    </div>
  )
}

function GatewayGrid({ gateways, agents, onRemove }) {
  return (
    <div className="space-y-6">
      {gateways.map(gw => (
        <GatewayCard 
          key={gw.id} 
          gateway={gw} 
          agents={agents.filter(a => a.gatewayId === gw.id)} 
          onRemove={() => onRemove(gw.id)}
        />
      ))}
    </div>
  )
}

function GatewayStatusIcon({ status }) {
  switch (status) {
    case 'online':
      return <CheckCircle2 className="w-4 h-4 text-green-400" />
    case 'connecting':
      return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
    case 'error':
      return <AlertCircle className="w-4 h-4 text-red-400" />
    case 'offline':
    case 'disconnected':
    default:
      return <WifiOff className="w-4 h-4 text-gray-400" />
  }
}

function GatewayCard({ gateway, agents, onRemove }) {
  const statusColors = {
    online: 'border-green-500/30 bg-green-500/5',
    connecting: 'border-blue-500/30 bg-blue-500/5',
    error: 'border-red-500/30 bg-red-500/5',
    offline: 'border-gray-500/30',
    disconnected: 'border-gray-500/30'
  }
  
  return (
    <div className={`card ${statusColors[gateway.status] || ''}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <GatewayStatusIcon status={gateway.status} />
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">{gateway.name || 'Gateway'}</h3>
              {gateway.autoDiscovered && (
                <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded">Auto</span>
              )}
              {gateway.hasToken && (
                <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded">Auth</span>
              )}
            </div>
            <p className="text-text-secondary text-sm">{gateway.url}</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {gateway.lastSeen && (
            <div className="flex items-center gap-1 text-text-muted text-xs">
              <Clock className="w-3 h-3" />
              <span>Last seen: {formatTimeAgo(gateway.lastSeen)}</span>
            </div>
          )}
          {gateway.lastError && (
            <span className="text-red-400 text-xs">{gateway.lastError}</span>
          )}
          <span className="text-text-muted text-sm">{agents.length} agents</span>
          <button 
            onClick={onRemove}
            className="p-2 text-text-muted hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
            title="Remove gateway"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
      {agents.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {agents.map(agent => <AgentCard key={agent.id} agent={agent} />)}
        </div>
      ) : (
        <p className="text-text-secondary text-sm py-4 text-center">
          {gateway.status === 'online' ? 'No agents discovered yet' : 'Waiting for connection...'}
        </p>
      )}
    </div>
  )
}

function AgentCard({ agent }) {
  const statusColors = {
    active: 'border-green-500/40 bg-green-500/10',
    idle: 'border-border-default',
    busy: 'border-amber-500/40 bg-amber-500/10',
    error: 'border-red-500/40 bg-red-500/10'
  }
  
  return (
    <div className={`bg-bg-hover rounded-lg p-3 border hover:border-border-active transition-colors cursor-pointer ${statusColors[agent.status] || statusColors.idle}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className={`status-dot status-${agent.status || 'idle'}`} />
        <span className="font-medium truncate">{agent.name || agent.id}</span>
      </div>
      <p className="text-text-secondary text-xs truncate">{agent.currentSession || 'Idle'}</p>
      {agent.lastActive && (
        <p className="text-text-muted text-xs mt-1">Active: {formatTimeAgo(agent.lastActive)}</p>
      )}
    </div>
  )
}

function EmptyState({ onAdd, onDiscover, discovering }) {
  return (
    <div className="flex flex-col items-center justify-center h-[60vh] text-center">
      <div className="bg-bg-card p-8 rounded-2xl border border-border-default mb-6">
        <Server className="w-16 h-16 text-text-muted mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">No Gateways Connected</h2>
        <p className="text-text-secondary mb-6 max-w-md">
          Connect your first Clawdbot gateway to start monitoring your agents in real-time.
        </p>
        <div className="flex justify-center gap-3">
          <button 
            onClick={onDiscover} 
            disabled={discovering}
            className="flex items-center gap-2 bg-bg-hover hover:bg-bg-card border border-border-default px-6 py-3 rounded-lg font-medium transition-colors disabled:opacity-50"
          >
            {discovering ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
            Auto-Discover
          </button>
          <button 
            onClick={onAdd} 
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 px-6 py-3 rounded-lg font-medium transition-colors"
          >
            <Plus className="w-4 h-4" /> Add Manually
          </button>
        </div>
      </div>
    </div>
  )
}

function AddGatewayModal({ onClose, onSubmit }) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [token, setToken] = useState('')

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!url.trim()) return
    onSubmit({ url: url.trim(), name: name.trim(), token: token.trim() })
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-bg-card border border-border-default rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">Add Gateway</h2>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-text-secondary mb-1">Gateway URL *</label>
              <input 
                value={url} 
                onChange={e => setUrl(e.target.value)} 
                placeholder="http://localhost:18789 or ws://..." 
                className="w-full bg-bg-dark border border-border-default rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                autoFocus
              />
              <p className="text-text-muted text-xs mt-1">HTTP or WebSocket URL to the Clawdbot gateway</p>
            </div>
            <div>
              <label className="block text-sm text-text-secondary mb-1">Display Name</label>
              <input 
                value={name} 
                onChange={e => setName(e.target.value)} 
                placeholder="Production Server" 
                className="w-full bg-bg-dark border border-border-default rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" 
              />
            </div>
            <div>
              <label className="block text-sm text-text-secondary mb-1">Auth Token</label>
              <input 
                type="password" 
                value={token} 
                onChange={e => setToken(e.target.value)} 
                placeholder="Optional auth token" 
                className="w-full bg-bg-dark border border-border-default rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" 
              />
              <p className="text-text-muted text-xs mt-1">Required if gateway has authentication enabled</p>
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button 
              type="button"
              onClick={onClose} 
              className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button 
              type="submit"
              className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              Connect
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// Helper functions
function formatTimeAgo(date) {
  if (!date) return 'Never'
  
  const seconds = Math.floor((new Date() - new Date(date)) / 1000)
  
  if (seconds < 10) return 'Just now'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export default App
