import { useState, useEffect, useCallback } from 'react'
import { io } from 'socket.io-client'
import { Server, Bot, Activity, Plus, Settings, RefreshCw } from 'lucide-react'

const socket = io({ autoConnect: true })

function App() {
  const [gateways, setGateways] = useState([])
  const [agents, setAgents] = useState([])
  const [connected, setConnected] = useState(false)
  const [showAddGateway, setShowAddGateway] = useState(false)

  useEffect(() => {
    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))
    socket.on('sync', (data) => {
      setGateways(data.gateways || [])
      setAgents(data.agents || [])
    })
    socket.on('gateway:added', (gw) => setGateways(prev => [...prev, gw]))
    socket.on('gateway:removed', ({ id }) => setGateways(prev => prev.filter(g => g.id !== id)))
    socket.on('agent:update', (agent) => {
      setAgents(prev => {
        const idx = prev.findIndex(a => a.id === agent.id)
        if (idx >= 0) return [...prev.slice(0, idx), agent, ...prev.slice(idx + 1)]
        return [...prev, agent]
      })
    })
    return () => socket.off()
  }, [])

  const addGateway = async (data) => {
    await fetch('/api/gateways', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
    setShowAddGateway(false)
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header connected={connected} onAddGateway={() => setShowAddGateway(true)} />
      <main className="flex-1 p-6">
        {gateways.length === 0 ? (
          <EmptyState onAdd={() => setShowAddGateway(true)} />
        ) : (
          <div className="space-y-8">
            <StatsBar gateways={gateways} agents={agents} />
            <GatewayGrid gateways={gateways} agents={agents} />
          </div>
        )}
      </main>
      {showAddGateway && (
        <AddGatewayModal onClose={() => setShowAddGateway(false)} onSubmit={addGateway} />
      )}
    </div>
  )
}

function Header({ connected, onAddGateway }) {
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
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-sm">
          <span className={`status-dot ${connected ? 'status-online' : 'status-offline'}`} />
          <span className="text-text-secondary">{connected ? 'Connected' : 'Disconnected'}</span>
        </div>
        <button onClick={onAddGateway} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
          <Plus className="w-4 h-4" /> Add Gateway
        </button>
      </div>
    </header>
  )
}

function StatsBar({ gateways, agents }) {
  const activeAgents = agents.filter(a => a.status === 'active').length
  return (
    <div className="grid grid-cols-4 gap-4">
      <StatCard label="Gateways" value={gateways.length} icon={<Server className="w-5 h-5" />} color="blue" />
      <StatCard label="Total Agents" value={agents.length} icon={<Bot className="w-5 h-5" />} color="purple" />
      <StatCard label="Active" value={activeAgents} icon={<Activity className="w-5 h-5" />} color="green" />
      <StatCard label="Sessions" value={agents.reduce((acc, a) => acc + (a.sessions?.length || 0), 0)} icon={<RefreshCw className="w-5 h-5" />} color="amber" />
    </div>
  )
}

function StatCard({ label, value, icon, color }) {
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
        </div>
        <div className="opacity-60">{icon}</div>
      </div>
    </div>
  )
}

function GatewayGrid({ gateways, agents }) {
  return (
    <div className="space-y-6">
      {gateways.map(gw => (
        <GatewayCard key={gw.id} gateway={gw} agents={agents.filter(a => a.gatewayId === gw.id)} />
      ))}
    </div>
  )
}

function GatewayCard({ gateway, agents }) {
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className={`status-dot status-${gateway.status}`} />
          <div>
            <h3 className="font-semibold">{gateway.name || 'Gateway'}</h3>
            <p className="text-text-secondary text-sm">{gateway.url}</p>
          </div>
        </div>
        <span className="text-text-muted text-sm">{agents.length} agents</span>
      </div>
      {agents.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {agents.map(agent => <AgentCard key={agent.id} agent={agent} />)}
        </div>
      ) : (
        <p className="text-text-secondary text-sm py-4 text-center">No agents discovered yet</p>
      )}
    </div>
  )
}

function AgentCard({ agent }) {
  return (
    <div className="bg-bg-hover rounded-lg p-3 border border-border-default hover:border-border-active transition-colors cursor-pointer">
      <div className="flex items-center gap-2 mb-2">
        <span className={`status-dot status-${agent.status || 'idle'}`} />
        <span className="font-medium">{agent.name || agent.id}</span>
      </div>
      <p className="text-text-secondary text-xs truncate">{agent.currentSession || 'Idle'}</p>
    </div>
  )
}

function EmptyState({ onAdd }) {
  return (
    <div className="flex flex-col items-center justify-center h-[60vh] text-center">
      <div className="bg-bg-card p-8 rounded-2xl border border-border-default mb-6">
        <Server className="w-16 h-16 text-text-muted mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">No Gateways Connected</h2>
        <p className="text-text-secondary mb-6 max-w-md">
          Connect your first Clawdbot gateway to start monitoring your agents in real-time.
        </p>
        <button onClick={onAdd} className="bg-blue-600 hover:bg-blue-700 px-6 py-3 rounded-lg font-medium transition-colors">
          <Plus className="w-4 h-4 inline mr-2" /> Add Your First Gateway
        </button>
      </div>
    </div>
  )
}

function AddGatewayModal({ onClose, onSubmit }) {
  const [url, setUrl] = useState('ws://localhost:18789')
  const [name, setName] = useState('')
  const [token, setToken] = useState('')

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-bg-card border border-border-default rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">Add Gateway</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1">Gateway URL</label>
            <input value={url} onChange={e => setUrl(e.target.value)} placeholder="ws://localhost:18789" className="w-full bg-bg-dark border border-border-default rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-border-active" />
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">Name (optional)</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="My Gateway" className="w-full bg-bg-dark border border-border-default rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-border-active" />
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">Token (if required)</label>
            <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Optional auth token" className="w-full bg-bg-dark border border-border-default rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-border-active" />
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors">Cancel</button>
          <button onClick={() => onSubmit({ url, name, token })} className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors">Connect</button>
        </div>
      </div>
    </div>
  )
}

export default App
