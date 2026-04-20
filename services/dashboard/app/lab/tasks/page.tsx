import LabSubNav from '@/components/lab/LabSubNav'
import TaskQueueExpanded from '@/components/lab/TaskQueueExpanded'

export const dynamic = 'force-dynamic'

export default function TasksPage() {
  return (
    <div className="min-h-screen p-4 md:p-6 max-w-7xl mx-auto">
      <LabSubNav />
      <TaskQueueExpanded />
    </div>
  )
}
