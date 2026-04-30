'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import type { TaskItem } from '@/app/api/taskqueue/route'

interface Node {
  id: string
  label: string
  status: string
  priority: number
}

interface Edge {
  from: string
  to: string
}

export interface TaskDependencyGraphProps {
  tasks: TaskItem[]
  onTaskSelect?: (taskId: string) => void
}

export default function TaskDependencyGraph({ tasks, onTaskSelect }: TaskDependencyGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })

  // Build graph from tasks
  const buildGraph = useCallback(() => {
    const nodes: Map<string, Node> = new Map()
    const edges: Edge[] = []

    // Filter to only tasks with dependencies or dependents
    const tasksWithDeps = tasks.filter(t =>
      (t.blocked_by_task_ids && t.blocked_by_task_ids.length > 0) ||
      tasks.some(other => other.blocked_by_task_ids?.includes(t.id))
    )

    if (tasksWithDeps.length === 0) {
      return { nodes, edges }
    }

    // Create nodes for tasks with dependencies
    tasksWithDeps.forEach(task => {
      nodes.set(task.id, {
        id: task.id,
        label: task.title.substring(0, 30) + (task.title.length > 30 ? '...' : ''),
        status: task.status,
        priority: task.priority,
      })
    })

    // Add nodes for blocking tasks that aren't in our view
    tasks.forEach(task => {
      if (task.blocked_by_task_ids) {
        task.blocked_by_task_ids.forEach(blockingId => {
          if (!nodes.has(blockingId)) {
            const blockingTask = tasks.find(t => t.id === blockingId)
            if (blockingTask) {
              nodes.set(blockingId, {
                id: blockingId,
                label: blockingTask.title.substring(0, 30) + (blockingTask.title.length > 30 ? '...' : ''),
                status: blockingTask.status,
                priority: blockingTask.priority,
              })
            }
          }
        })
      }
    })

    // Create edges (blocked_by means task -> blocking task)
    tasks.forEach(task => {
      if (task.blocked_by_task_ids) {
        task.blocked_by_task_ids.forEach(blockingId => {
          edges.push({ from: blockingId, to: task.id })
        })
      }
    })

    return { nodes, edges }
  }, [tasks])

  // Simple force-directed layout
  const calculateLayout = useCallback((nodes: Map<string, Node>, edges: Edge[]) => {
    const positions: Map<string, { x: number; y: number }> = new Map()
    const nodeArray = Array.from(nodes.values())

    // Initialize random positions
    nodeArray.forEach((node, i) => {
      positions.set(node.id, {
        x: (i % 5) * 150 + 50,
        y: Math.floor(i / 5) * 150 + 50,
      })
    })

    // Simple force simulation (just a few iterations)
    for (let iter = 0; iter < 10; iter++) {
      const forces: Map<string, { x: number; y: number }> = new Map()
      nodeArray.forEach(node => {
        forces.set(node.id, { x: 0, y: 0 })
      })

      // Repulsive forces
      nodeArray.forEach((node, i) => {
        nodeArray.slice(i + 1).forEach(other => {
          const pos1 = positions.get(node.id)!
          const pos2 = positions.get(other.id)!
          const dx = pos2.x - pos1.x
          const dy = pos2.y - pos1.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          const repel = 10000 / (dist * dist)
          const fx = (dx / dist) * repel
          const fy = (dy / dist) * repel
          forces.get(node.id)!.x -= fx
          forces.get(node.id)!.y -= fy
          forces.get(other.id)!.x += fx
          forces.get(other.id)!.y += fy
        })
      })

      // Attractive forces along edges
      edges.forEach(edge => {
        const from = positions.get(edge.from)!
        const to = positions.get(edge.to)!
        const dx = to.x - from.x
        const dy = to.y - from.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const pull = (dist - 100) * 0.1
        const fx = (dx / dist) * pull
        const fy = (dy / dist) * pull
        forces.get(edge.from)!.x += fx
        forces.get(edge.from)!.y += fy
        forces.get(edge.to)!.x -= fx
        forces.get(edge.to)!.y -= fy
      })

      // Apply forces
      nodeArray.forEach(node => {
        const pos = positions.get(node.id)!
        const force = forces.get(node.id)!
        pos.x += force.x * 0.05
        pos.y += force.y * 0.05
      })
    }

    return positions
  }, [])

  // Draw graph on canvas
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const { nodes, edges } = buildGraph()
    if (nodes.size === 0) return

    const positions = calculateLayout(nodes, edges)
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    canvas.width = canvas.offsetWidth
    canvas.height = canvas.offsetHeight

    // Clear
    ctx.fillStyle = '#09090b'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const getStatusColor = (status: string) => {
      const colors: Record<string, string> = {
        completed: '#34d399',
        in_progress_jeff: '#22d3ee',
        in_progress_agent: '#60a5fa',
        blocked: '#fbbf24',
        pending_jeff_action: '#f43f5e',
        review_needed: '#fb923c',
        ready: '#a1a1aa',
        failed: '#f87171',
      }
      return colors[status] || '#71717a'
    }

    // Draw edges
    ctx.strokeStyle = '#52525b'
    ctx.lineWidth = 2
    edges.forEach(edge => {
      const from = positions.get(edge.from)
      const to = positions.get(edge.to)
      if (from && to) {
        ctx.beginPath()
        ctx.moveTo(from.x * zoom + pan.x, from.y * zoom + pan.y)
        ctx.lineTo(to.x * zoom + pan.x, to.y * zoom + pan.y)
        ctx.stroke()

        // Arrow head
        const angle = Math.atan2(to.y - from.y, to.x - from.x)
        ctx.fillStyle = '#52525b'
        ctx.beginPath()
        const arrowSize = 8
        const endX = to.x * zoom + pan.x
        const endY = to.y * zoom + pan.y
        ctx.moveTo(endX, endY)
        ctx.lineTo(endX - arrowSize * Math.cos(angle - Math.PI / 6), endY - arrowSize * Math.sin(angle - Math.PI / 6))
        ctx.lineTo(endX - arrowSize * Math.cos(angle + Math.PI / 6), endY - arrowSize * Math.sin(angle + Math.PI / 6))
        ctx.closePath()
        ctx.fill()
      }
    })

    // Draw nodes
    nodes.forEach(node => {
      const pos = positions.get(node.id)!
      const x = pos.x * zoom + pan.x
      const y = pos.y * zoom + pan.y
      const radius = 30 * zoom

      // Node circle
      ctx.fillStyle = getStatusColor(node.status)
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.fill()

      // Border for selected
      if (selectedNodeId === node.id) {
        ctx.strokeStyle = '#fbbf24'
        ctx.lineWidth = 3
        ctx.stroke()
      }

      // Priority badge
      const priorityColor = ['#dc2626', '#f97316', '#84cc16', '#6b7280'][node.priority] || '#6b7280'
      ctx.fillStyle = priorityColor
      ctx.font = 'bold 10px monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(
        ['C', 'H', 'M', 'L'][node.priority] || '?',
        x,
        y
      )
    })

    // Draw labels
    ctx.fillStyle = '#e4e4e7'
    ctx.font = '11px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    nodes.forEach(node => {
      const pos = positions.get(node.id)!
      const x = pos.x * zoom + pan.x
      const y = pos.y * zoom + pan.y
      const radius = 30 * zoom
      ctx.fillText(node.label, x, y + radius + 10)
    })
  }, [selectedNodeId, zoom, pan, buildGraph, calculateLayout])

  // Mouse events
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    // Check if clicked on a node
    const { nodes, edges: _ } = buildGraph()
    const positions = calculateLayout(nodes, Array.from(nodes.values()).length > 0 ? [] : [])

    let foundNode = false
    nodes.forEach(node => {
      const pos = positions.get(node.id)!
      const nodeX = pos.x * zoom + pan.x
      const nodeY = pos.y * zoom + pan.y
      const radius = 30 * zoom
      const dist = Math.sqrt((x - nodeX) ** 2 + (y - nodeY) ** 2)
      if (dist <= radius) {
        setSelectedNodeId(node.id)
        onTaskSelect?.(node.id)
        foundNode = true
      }
    })

    if (!foundNode) {
      setIsDragging(true)
      setDragStart({ x, y })
    }
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDragging) return
    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    setPan({
      x: pan.x + (x - dragStart.x),
      y: pan.y + (y - dragStart.y),
    })
    setDragStart({ x, y })
  }

  const handleMouseUp = () => {
    setIsDragging(false)
  }

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setZoom(Math.max(0.5, Math.min(3, zoom * delta)))
  }

  const handleResetView = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setSelectedNodeId(null)
  }

  const { nodes } = buildGraph()
  const isEmpty = nodes.size === 0

  return (
    <div className="w-full h-full flex flex-col bg-zinc-950">
      <div className="flex items-center justify-between p-3 border-b border-zinc-800 bg-zinc-900/50">
        <div className="text-sm text-zinc-400">
          {isEmpty ? (
            <span>No task dependencies found. Add dependencies using the task edit form.</span>
          ) : (
            <span>{nodes.size} tasks with dependencies • Drag to pan, scroll to zoom, click a node to open task</span>
          )}
        </div>
        {!isEmpty && (
          <button
            onClick={handleResetView}
            className="px-3 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition"
          >
            Reset View
          </button>
        )}
      </div>
      <div className="flex-1 relative overflow-hidden">
        {isEmpty ? (
          <div className="w-full h-full flex items-center justify-center text-center">
            <div className="text-zinc-500">
              <p className="text-sm mb-2">No task dependencies yet</p>
              <p className="text-xs">Create dependencies by editing a task and selecting which tasks block it</p>
            </div>
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            className="w-full h-full cursor-grab active:cursor-grabbing"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onWheel={handleWheel}
          />
        )}
      </div>
    </div>
  )
}
