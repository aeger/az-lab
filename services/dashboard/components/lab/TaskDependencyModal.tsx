'use client'

import { useEffect, useState } from 'react'
import type { TaskItem } from '@/app/api/taskqueue/route'

interface TaskDependencyModalProps {
  task: TaskItem
  allTasks: TaskItem[]
  onClose: () => void
  onSave: (blockedByIds: string[]) => Promise<void>
}

export default function TaskDependencyModal({ task, allTasks, onClose, onSave }: TaskDependencyModalProps) {
  const [blockedByIds, setBlockedByIds] = useState<string[]>(task.blocked_by_task_ids || [])
  const [isSaving, setIsSaving] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')

  // Filter tasks: exclude self and already selected
  const availableTasks = allTasks.filter(
    t => t.id !== task.id && !blockedByIds.includes(t.id)
  )

  const filteredTasks = availableTasks.filter(t =>
    t.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
    t.id.includes(searchTerm)
  )

  const getBlockingTaskDetails = (id: string) => {
    return allTasks.find(t => t.id === id)
  }

  const handleAddDependency = (taskId: string) => {
    setBlockedByIds([...blockedByIds, taskId])
    setSearchTerm('')
  }

  const handleRemoveDependency = (taskId: string) => {
    setBlockedByIds(blockedByIds.filter(id => id !== taskId))
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      await onSave(blockedByIds)
      onClose()
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="p-4 border-b border-zinc-700 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Task Dependencies</h2>
            <p className="text-sm text-zinc-400 mt-1">{task.title}</p>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-300 transition"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Current blocking tasks */}
          <div>
            <h3 className="text-sm font-medium text-zinc-300 mb-2">Blocked By ({blockedByIds.length})</h3>
            {blockedByIds.length === 0 ? (
              <p className="text-xs text-zinc-500 py-2">No dependencies. This task can proceed immediately.</p>
            ) : (
              <div className="space-y-2">
                {blockedByIds.map(id => {
                  const blockingTask = getBlockingTaskDetails(id)
                  if (!blockingTask) return null
                  return (
                    <div
                      key={id}
                      className="flex items-center justify-between p-2 bg-zinc-800/50 rounded border border-zinc-700 hover:border-zinc-600 transition"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-zinc-200 truncate">{blockingTask.title}</p>
                        <p className="text-xs text-zinc-500">
                          Status: <span className="text-zinc-400">{blockingTask.status}</span>
                        </p>
                      </div>
                      <button
                        onClick={() => handleRemoveDependency(id)}
                        className="ml-2 px-2 py-1 text-xs rounded bg-red-900/40 hover:bg-red-900/60 text-red-300 transition flex-shrink-0"
                      >
                        Remove
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Add new dependencies */}
          <div className="border-t border-zinc-700 pt-4">
            <h3 className="text-sm font-medium text-zinc-300 mb-2">Add Dependency</h3>
            <input
              type="text"
              placeholder="Search by title or ID..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 mb-3"
            />

            {filteredTasks.length === 0 && searchTerm === '' ? (
              <p className="text-xs text-zinc-500">All available tasks are already selected or excluded.</p>
            ) : filteredTasks.length === 0 ? (
              <p className="text-xs text-zinc-500">No tasks match your search.</p>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {filteredTasks.map(availTask => (
                  <div
                    key={availTask.id}
                    className="flex items-center justify-between p-2 bg-zinc-800/30 rounded border border-zinc-700 hover:border-zinc-600 transition cursor-pointer"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-zinc-200 truncate">{availTask.title}</p>
                      <p className="text-xs text-zinc-500">
                        <span className={
                          availTask.status === 'completed' ? 'text-emerald-400' :
                          availTask.status === 'in_progress_agent' || availTask.status === 'in_progress_jeff' ? 'text-blue-400' :
                          availTask.status === 'blocked' ? 'text-amber-400' : 'text-zinc-400'
                        }>
                          {availTask.status}
                        </span>
                      </p>
                    </div>
                    <button
                      onClick={() => handleAddDependency(availTask.id)}
                      className="ml-2 px-2 py-1 text-xs rounded bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-300 transition flex-shrink-0"
                    >
                      Add
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="p-4 border-t border-zinc-700 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={isSaving}
            className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="px-4 py-2 rounded bg-emerald-900 hover:bg-emerald-800 text-emerald-100 text-sm transition disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Save Dependencies'}
          </button>
        </div>
      </div>
    </div>
  )
}
