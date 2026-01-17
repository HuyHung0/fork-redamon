/**
 * Todo List Widget Component
 *
 * Displays agent's todo list with status indicators.
 */

'use client'

import { CheckCircle2, Circle, Loader2 } from 'lucide-react'
import styles from './TodoListWidget.module.css'
import type { TodoItem } from '@/lib/websocket-types'

interface TodoListWidgetProps {
  items: TodoItem[]
}

export function TodoListWidget({ items }: TodoListWidgetProps) {
  if (!items || items.length === 0) {
    return (
      <div className={styles.emptyState}>
        <p className={styles.emptyText}>No tasks yet</p>
      </div>
    )
  }

  const getStatusIcon = (status: TodoItem['status']) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 size={14} className={styles.iconCompleted} />
      case 'in_progress':
        return <Loader2 size={14} className={`${styles.iconInProgress} ${styles.spinner}`} />
      case 'pending':
      default:
        return <Circle size={14} className={styles.iconPending} />
    }
  }

  const getStatusClass = (status: TodoItem['status']) => {
    switch (status) {
      case 'completed':
        return styles.statusCompleted
      case 'in_progress':
        return styles.statusInProgress
      case 'pending':
      default:
        return styles.statusPending
    }
  }

  const getDescription = (item: TodoItem) => {
    // Prioritize activeForm for in_progress items
    if (item.status === 'in_progress' && item.activeForm && item.activeForm.trim()) {
      return item.activeForm
    }

    // Backend uses 'description' field
    if (item.description && item.description.trim()) {
      return item.description
    }

    // Fallback to 'content' for backward compatibility
    if (item.content && item.content.trim()) {
      return item.content
    }

    // Fallback
    return 'No description'
  }

  return (
    <div className={styles.todoList}>
      {items.map((item, index) => {
        const description = getDescription(item)
        return (
          <div key={index} className={`${styles.todoItem} ${getStatusClass(item.status)}`}>
            <div className={styles.todoIcon}>{getStatusIcon(item.status)}</div>
            <div className={styles.todoContent}>
              <span className={styles.todoDescription}>{description}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
