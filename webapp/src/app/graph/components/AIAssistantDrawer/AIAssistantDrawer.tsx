/**
 * AI Assistant Drawer - WebSocket Version
 *
 * Real-time bidirectional communication with the agent using WebSocket.
 * Features streaming thoughts, tool executions, and beautiful timeline UI.
 * Single scrollable chat with all messages, thinking, and tool executions inline.
 */

'use client'

import { useState, useRef, useEffect, useCallback, KeyboardEvent } from 'react'
import { Send, Bot, User, Loader2, AlertCircle, Sparkles, RotateCcw, Shield, Target, Zap, HelpCircle, WifiOff, Wifi } from 'lucide-react'
import styles from './AIAssistantDrawer.module.css'
import { useAgentWebSocket } from '@/hooks/useAgentWebSocket'
import {
  MessageType,
  ConnectionStatus,
  type ServerMessage,
  type ApprovalRequestPayload,
  type QuestionRequestPayload,
  type TodoItem
} from '@/lib/websocket-types'
import { AgentTimeline } from './AgentTimeline'
import { TodoListWidget } from './TodoListWidget'
import type { ThinkingItem, ToolExecutionItem } from './AgentTimeline'

type Phase = 'informational' | 'exploitation' | 'post_exploitation'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolUsed?: string | null
  toolOutput?: string | null
  error?: string | null
  phase?: Phase
  timestamp: Date
}

type ChatItem = Message | ThinkingItem | ToolExecutionItem

interface AIAssistantDrawerProps {
  isOpen: boolean
  onClose: () => void
  userId: string
  projectId: string
  sessionId: string
  onResetSession?: () => void
}

const PHASE_CONFIG = {
  informational: {
    label: 'Informational',
    icon: Shield,
    color: 'var(--accent-primary)',
    bgColor: 'rgba(59, 130, 246, 0.1)',
  },
  exploitation: {
    label: 'Exploitation',
    icon: Target,
    color: 'var(--status-warning)',
    bgColor: 'rgba(245, 158, 11, 0.1)',
  },
  post_exploitation: {
    label: 'Post-Exploitation',
    icon: Zap,
    color: 'var(--status-error)',
    bgColor: 'rgba(239, 68, 68, 0.1)',
  },
}

export function AIAssistantDrawer({
  isOpen,
  onClose,
  userId,
  projectId,
  sessionId,
  onResetSession,
}: AIAssistantDrawerProps) {
  const [chatItems, setChatItems] = useState<ChatItem[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [currentPhase, setCurrentPhase] = useState<Phase>('informational')
  const [iterationCount, setIterationCount] = useState(0)
  const [awaitingApproval, setAwaitingApproval] = useState(false)
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequestPayload | null>(null)
  const [modificationText, setModificationText] = useState('')

  // Q&A state
  const [awaitingQuestion, setAwaitingQuestion] = useState(false)
  const [questionRequest, setQuestionRequest] = useState<QuestionRequestPayload | null>(null)
  const [answerText, setAnswerText] = useState('')
  const [selectedOptions, setSelectedOptions] = useState<string[]>([])

  const [todoList, setTodoList] = useState<TodoItem[]>([])

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [chatItems, scrollToBottom])

  useEffect(() => {
    if (isOpen && inputRef.current && !awaitingApproval) {
      setTimeout(() => inputRef.current?.focus(), 300)
    }
  }, [isOpen, awaitingApproval])

  // Reset state when session changes
  useEffect(() => {
    setChatItems([])
    setCurrentPhase('informational')
    setIterationCount(0)
    setAwaitingApproval(false)
    setApprovalRequest(null)
    setAwaitingQuestion(false)
    setQuestionRequest(null)
    setAnswerText('')
    setSelectedOptions([])
    setTodoList([])
  }, [sessionId])

  // WebSocket message handler
  const handleWebSocketMessage = useCallback((message: ServerMessage) => {
    switch (message.type) {
      case MessageType.CONNECTED:
        break

      case MessageType.THINKING:
        // Add thinking item to chat
        const thinkingItem: ThinkingItem = {
          type: 'thinking',
          id: `thinking-${Date.now()}`,
          timestamp: new Date(),
          thought: message.payload.thought || '',
          reasoning: message.payload.reasoning || '',
          action: 'thinking',
          updated_todo_list: todoList,
        }
        setChatItems(prev => [...prev, thinkingItem])
        break

      case MessageType.TOOL_START:
        // Add tool execution item to chat
        const toolItem: ToolExecutionItem = {
          type: 'tool_execution',
          id: `tool-${Date.now()}`,
          timestamp: new Date(),
          tool_name: message.payload.tool_name,
          tool_args: message.payload.tool_args,
          status: 'running',
          output_chunks: [],
        }
        setChatItems(prev => [...prev, toolItem])
        setIsLoading(true)
        break

      case MessageType.TOOL_OUTPUT_CHUNK:
        // Append output chunk to last tool execution item
        setChatItems(prev => {
          const lastItem = prev[prev.length - 1]
          if (lastItem && 'type' in lastItem && lastItem.type === 'tool_execution') {
            return [
              ...prev.slice(0, -1),
              {
                ...lastItem,
                output_chunks: [...lastItem.output_chunks, message.payload.chunk],
              }
            ]
          }
          return prev
        })
        break

      case MessageType.TOOL_COMPLETE:
        // Mark tool as complete
        setChatItems(prev => {
          const lastItem = prev[prev.length - 1]
          if (lastItem && 'type' in lastItem && lastItem.type === 'tool_execution') {
            const updatedItem: ToolExecutionItem = {
              ...lastItem,
              status: message.payload.success ? 'success' : 'error',
              final_output: message.payload.output_summary,
            }
            return [
              ...prev.slice(0, -1),
              updatedItem
            ]
          }
          return prev
        })
        setIsLoading(false)
        break

      case MessageType.PHASE_UPDATE:
        setCurrentPhase(message.payload.current_phase as Phase)
        setIterationCount(message.payload.iteration_count)
        break

      case MessageType.TODO_UPDATE:
        setTodoList(message.payload.todo_list)
        // Update the last thinking item with the new todo list
        setChatItems(prev => {
          if (prev.length === 0) return prev
          const lastItem = prev[prev.length - 1]
          if ('type' in lastItem && lastItem.type === 'thinking') {
            return [
              ...prev.slice(0, -1),
              { ...lastItem, updated_todo_list: message.payload.todo_list }
            ]
          }
          return prev
        })
        break

      case MessageType.APPROVAL_REQUEST:
        setAwaitingApproval(true)
        setApprovalRequest(message.payload)
        setIsLoading(false)
        break

      case MessageType.QUESTION_REQUEST:
        setAwaitingQuestion(true)
        setQuestionRequest(message.payload)
        setIsLoading(false)
        break

      case MessageType.RESPONSE:
        // Add agent response message
        const assistantMessage: Message = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: message.payload.answer,
          phase: message.payload.phase as Phase,
          timestamp: new Date(),
        }
        setChatItems(prev => [...prev, assistantMessage])
        setIsLoading(false)
        break

      case MessageType.ERROR:
        const errorMessage: Message = {
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: 'An error occurred while processing your request.',
          error: message.payload.message,
          timestamp: new Date(),
        }
        setChatItems(prev => [...prev, errorMessage])
        setIsLoading(false)
        break

      case MessageType.TASK_COMPLETE:
        const completeMessage: Message = {
          id: `complete-${Date.now()}`,
          role: 'assistant',
          content: message.payload.message,
          phase: message.payload.final_phase as Phase,
          timestamp: new Date(),
        }
        setChatItems(prev => [...prev, completeMessage])
        setIsLoading(false)
        break
    }
  }, [todoList])

  // Initialize WebSocket
  const { status, isConnected, reconnectAttempt, sendQuery, sendApproval, sendAnswer } = useAgentWebSocket({
    userId: userId || process.env.NEXT_PUBLIC_USER_ID || 'default_user',
    projectId: projectId || process.env.NEXT_PUBLIC_PROJECT_ID || 'default_project',
    sessionId: sessionId || process.env.NEXT_PUBLIC_SESSION_ID || 'default_session',
    enabled: isOpen,
    onMessage: handleWebSocketMessage,
    onError: (error) => {
      // Only show connection errors once, not for every retry
      if (error.message === 'Initial connection failed') {
        const errorMsg: Message = {
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: `Failed to connect to agent. Please check that the backend is running at ${process.env.NEXT_PUBLIC_AGENT_WS_URL || 'ws://localhost:8090/ws/agent'}`,
          error: error.message,
          timestamp: new Date(),
        }
        setChatItems(prev => [...prev, errorMsg])
      }
    },
  })

  const handleSend = useCallback(() => {
    const question = inputValue.trim()
    if (!question || !isConnected || awaitingApproval || awaitingQuestion) return

    // Add user message to chat
    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: question,
      timestamp: new Date(),
    }
    setChatItems(prev => [...prev, userMessage])
    setInputValue('')
    setIsLoading(true)

    // Send via WebSocket
    try {
      sendQuery(question)
    } catch (error) {
      setIsLoading(false)
    }
  }, [inputValue, isConnected, awaitingApproval, awaitingQuestion, sendQuery])

  const handleApproval = useCallback((decision: 'approve' | 'modify' | 'abort') => {
    // Prevent double submission
    if (!awaitingApproval) {
      return
    }

    setAwaitingApproval(false)
    setApprovalRequest(null)
    setIsLoading(true)

    // Add decision message
    const decisionMessage: Message = {
      id: `decision-${Date.now()}`,
      role: 'user',
      content: decision === 'approve'
        ? 'Approved phase transition'
        : decision === 'modify'
        ? `Modified: ${modificationText}`
        : 'Aborted phase transition',
      timestamp: new Date(),
    }
    setChatItems(prev => [...prev, decisionMessage])

    try {
      sendApproval(decision, decision === 'modify' ? modificationText : undefined)
      setModificationText('')
    } catch (error) {
      setIsLoading(false)
    }
  }, [modificationText, sendApproval, awaitingApproval, chatItems.length])

  const handleAnswer = useCallback(() => {
    if (!questionRequest) return

    setAwaitingQuestion(false)
    setQuestionRequest(null)
    setIsLoading(true)

    const answer = questionRequest.format === 'text'
      ? answerText
      : selectedOptions.join(', ')

    // Add answer message
    const answerMessage: Message = {
      id: `answer-${Date.now()}`,
      role: 'user',
      content: `Answer: ${answer}`,
      timestamp: new Date(),
    }
    setChatItems(prev => [...prev, answerMessage])

    try {
      sendAnswer(answer)
      setAnswerText('')
      setSelectedOptions([])
    } catch (error) {
      setIsLoading(false)
    }
  }, [questionRequest, answerText, selectedOptions, sendAnswer])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`
  }

  const handleNewChat = () => {
    setChatItems([])
    setCurrentPhase('informational')
    setIterationCount(0)
    setAwaitingApproval(false)
    setApprovalRequest(null)
    setAwaitingQuestion(false)
    setQuestionRequest(null)
    setAnswerText('')
    setSelectedOptions([])
    setTodoList([])
    onResetSession?.()
  }

  const PhaseIcon = PHASE_CONFIG[currentPhase].icon

  // Connection status indicator
  const getConnectionStatusIcon = () => {
    if (status === ConnectionStatus.CONNECTED) {
      return <Wifi size={12} className={styles.connectionIcon} />
    } else if (status === ConnectionStatus.RECONNECTING) {
      return <Loader2 size={12} className={`${styles.connectionIcon} ${styles.spinner}`} />
    } else {
      return <WifiOff size={12} className={styles.connectionIcon} />
    }
  }

  const getConnectionStatusText = () => {
    switch (status) {
      case ConnectionStatus.CONNECTING:
        return 'Connecting...'
      case ConnectionStatus.CONNECTED:
        return 'Connected'
      case ConnectionStatus.RECONNECTING:
        return `Reconnecting... (${reconnectAttempt}/5)`
      case ConnectionStatus.FAILED:
        return 'Connection failed'
      case ConnectionStatus.DISCONNECTED:
        return 'Disconnected'
    }
  }

  // Separate messages from timeline items
  const messages = chatItems.filter((item): item is Message => 'role' in item)
  const timelineItems = chatItems.filter((item): item is ThinkingItem | ToolExecutionItem =>
    'type' in item && (item.type === 'thinking' || item.type === 'tool_execution')
  )

  const renderMessage = (item: Message) => {
    return (
      <div
        key={item.id}
        className={`${styles.message} ${
          item.role === 'user' ? styles.messageUser : styles.messageAssistant
        }`}
      >
        <div className={styles.messageIcon}>
          {item.role === 'user' ? <User size={14} /> : <Bot size={14} />}
        </div>
        <div className={styles.messageContent}>
          {item.role === 'assistant' && item.phase && (
            <div
              className={styles.messagePhaseBadge}
              style={{
                backgroundColor: PHASE_CONFIG[item.phase].bgColor,
                color: PHASE_CONFIG[item.phase].color,
              }}
            >
              {PHASE_CONFIG[item.phase].label}
            </div>
          )}

          <div className={styles.messageText}>
            {item.content.split('\n').map((line, i) => (
              <p key={i}>{line || '\u00A0'}</p>
            ))}
          </div>

          {item.error && (
            <div className={styles.errorBadge}>
              <AlertCircle size={12} />
              <span>{item.error}</span>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className={`${styles.drawer} ${isOpen ? styles.drawerOpen : ''}`}
      aria-hidden={!isOpen}
    >
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.headerIcon}>
            <Sparkles size={16} />
          </div>
          <div className={styles.headerText}>
            <h2 className={styles.title}>AI Assistant</h2>
            <div className={styles.connectionStatus}>
              {getConnectionStatusIcon()}
              <span className={styles.subtitle}>{getConnectionStatusText()}</span>
            </div>
          </div>
        </div>
        <div className={styles.headerActions}>
          <button
            className={styles.iconButton}
            onClick={handleNewChat}
            title="New conversation"
            aria-label="Start new conversation"
          >
            <RotateCcw size={14} />
          </button>
          <button
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close assistant"
          >
            &times;
          </button>
        </div>
      </div>

      {/* Phase Indicator */}
      <div className={styles.phaseIndicator}>
        <div
          className={styles.phaseBadge}
          style={{
            backgroundColor: PHASE_CONFIG[currentPhase].bgColor,
            borderColor: PHASE_CONFIG[currentPhase].color,
          }}
        >
          <PhaseIcon size={14} style={{ color: PHASE_CONFIG[currentPhase].color }} />
          <span style={{ color: PHASE_CONFIG[currentPhase].color }}>
            {PHASE_CONFIG[currentPhase].label}
          </span>
        </div>
        {iterationCount > 0 && (
          <span className={styles.iterationCount}>Step {iterationCount}</span>
        )}
      </div>

      {/* Todo List Widget */}
      {todoList.length > 0 && (
        <div className={styles.todoWidgetContainer}>
          <TodoListWidget items={todoList} />
        </div>
      )}

      {/* Unified Chat (Messages + Timeline Items) */}
      <div className={styles.messages}>
        {chatItems.length === 0 && (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>
              <Bot size={32} />
            </div>
            <h3 className={styles.emptyTitle}>How can I help you?</h3>
            <p className={styles.emptyDescription}>
              Ask me about vulnerabilities, scan results, or query the graph database.
            </p>
            <div className={styles.suggestions}>
              <button
                className={styles.suggestion}
                onClick={() => setInputValue('What vulnerabilities were found?')}
                disabled={!isConnected}
              >
                What vulnerabilities were found?
              </button>
              <button
                className={styles.suggestion}
                onClick={() => setInputValue('Show me all CVEs with critical severity')}
                disabled={!isConnected}
              >
                Show me critical CVEs
              </button>
              <button
                className={styles.suggestion}
                onClick={() => setInputValue('What technologies are in use?')}
                disabled={!isConnected}
              >
                What technologies are in use?
              </button>
            </div>
          </div>
        )}

        {/* Timeline Section */}
        {timelineItems.length > 0 && (
          <AgentTimeline
            items={timelineItems}
            isStreaming={isLoading}
          />
        )}

        {/* Messages Section */}
        {messages.map(renderMessage)}

        {isLoading && (
          <div className={`${styles.message} ${styles.messageAssistant}`}>
            <div className={styles.messageIcon}>
              <Bot size={14} />
            </div>
            <div className={styles.messageContent}>
              <div className={styles.loadingIndicator}>
                <Loader2 size={14} className={styles.spinner} />
                <span>Processing...</span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Approval Dialog */}
      {awaitingApproval && approvalRequest && (
        <div className={styles.approvalDialog}>
          <div className={styles.approvalHeader}>
            <AlertCircle size={16} />
            <span>Phase Transition Request</span>
          </div>
          <div className={styles.approvalContent}>
            <p className={styles.approvalTransition}>
              <span className={styles.approvalFrom}>{approvalRequest.from_phase}</span>
              <span className={styles.approvalArrow}>→</span>
              <span className={styles.approvalTo}>{approvalRequest.to_phase}</span>
            </p>
            <p className={styles.approvalReason}>{approvalRequest.reason}</p>

            {approvalRequest.planned_actions.length > 0 && (
              <div className={styles.approvalSection}>
                <strong>Planned Actions:</strong>
                <ul>
                  {approvalRequest.planned_actions.map((action, i) => (
                    <li key={i}>{action}</li>
                  ))}
                </ul>
              </div>
            )}

            {approvalRequest.risks.length > 0 && (
              <div className={styles.approvalSection}>
                <strong>Risks:</strong>
                <ul>
                  {approvalRequest.risks.map((risk, i) => (
                    <li key={i}>{risk}</li>
                  ))}
                </ul>
              </div>
            )}

            <textarea
              className={styles.modificationInput}
              placeholder="Optional: provide modification feedback..."
              value={modificationText}
              onChange={(e) => setModificationText(e.target.value)}
            />
          </div>
          <div className={styles.approvalActions}>
            <button
              className={`${styles.approvalButton} ${styles.approvalButtonApprove}`}
              onClick={() => handleApproval('approve')}
              disabled={isLoading}
            >
              Approve
            </button>
            <button
              className={`${styles.approvalButton} ${styles.approvalButtonModify}`}
              onClick={() => handleApproval('modify')}
              disabled={isLoading || !modificationText.trim()}
            >
              Modify
            </button>
            <button
              className={`${styles.approvalButton} ${styles.approvalButtonAbort}`}
              onClick={() => handleApproval('abort')}
              disabled={isLoading}
            >
              Abort
            </button>
          </div>
        </div>
      )}

      {/* Q&A Dialog */}
      {awaitingQuestion && questionRequest && (
        <div className={styles.questionDialog}>
          <div className={styles.questionHeader}>
            <HelpCircle size={16} />
            <span>Agent Question</span>
          </div>
          <div className={styles.questionContent}>
            <p className={styles.questionText}>{questionRequest.question}</p>
            <p className={styles.questionContext}>{questionRequest.context}</p>

            {questionRequest.format === 'text' && (
              <textarea
                className={styles.answerInput}
                placeholder={questionRequest.default_value || 'Type your answer...'}
                value={answerText}
                onChange={(e) => setAnswerText(e.target.value)}
              />
            )}

            {questionRequest.format === 'single_choice' && questionRequest.options.length > 0 && (
              <div className={styles.optionsList}>
                {questionRequest.options.map((option, i) => (
                  <label key={i} className={styles.optionRadio}>
                    <input
                      type="radio"
                      name="question-option"
                      value={option}
                      checked={selectedOptions[0] === option}
                      onChange={() => setSelectedOptions([option])}
                    />
                    <span>{option}</span>
                  </label>
                ))}
              </div>
            )}

            {questionRequest.format === 'multi_choice' && questionRequest.options.length > 0 && (
              <div className={styles.optionsList}>
                {questionRequest.options.map((option, i) => (
                  <label key={i} className={styles.optionCheckbox}>
                    <input
                      type="checkbox"
                      value={option}
                      checked={selectedOptions.includes(option)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedOptions([...selectedOptions, option])
                        } else {
                          setSelectedOptions(selectedOptions.filter(o => o !== option))
                        }
                      }}
                    />
                    <span>{option}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className={styles.questionActions}>
            <button
              className={`${styles.answerButton} ${styles.answerButtonSubmit}`}
              onClick={handleAnswer}
              disabled={isLoading || (questionRequest.format === 'text' ? !answerText.trim() : selectedOptions.length === 0)}
            >
              Submit Answer
            </button>
          </div>
        </div>
      )}

      {/* Input */}
      <div className={styles.inputContainer}>
        <div className={styles.inputWrapper}>
          <textarea
            ref={inputRef}
            className={styles.input}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={
              !isConnected
                ? 'Connecting to agent...'
                : awaitingApproval
                ? 'Respond to the approval request above...'
                : awaitingQuestion
                ? 'Answer the question above...'
                : 'Ask a question...'
            }
            rows={1}
            disabled={isLoading || awaitingApproval || awaitingQuestion || !isConnected}
          />
          <button
            className={styles.sendButton}
            onClick={handleSend}
            disabled={!inputValue.trim() || isLoading || awaitingApproval || awaitingQuestion || !isConnected}
            aria-label="Send message"
          >
            {isLoading ? <Loader2 size={16} className={styles.spinner} /> : <Send size={16} />}
          </button>
        </div>
        <span className={styles.inputHint}>
          {isConnected ? 'Press Enter to send, Shift+Enter for new line' : 'Waiting for connection...'}
        </span>
      </div>
    </div>
  )
}
