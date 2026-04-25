# Relay Architecture

Diagrams of the core runtime. Read alongside `SPEC.md` (data model) and `CLAUDE.md` (engineering rules).

---

## 1. System Overview

```mermaid
graph TB
    Client["Client / Caller"]

    subgraph HTTP["HTTP API (Hono)"]
        RT["/trigger (POST)"]
        RA["/agents (POST)"]
    end

    subgraph PG["PostgreSQL"]
        TE["trigger_envelopes"]
        WQ["work_queue"]
        SES["sessions"]
        TRN["turns"]
        MSG["inbound_messages"]
        AGT["agents"]
        MEM["memory"]
        TSK["tasks"]
    end

    subgraph Workers["Worker Pool (N processes)"]
        WL["Worker Loop\n(dequeue → dispatch)"]

        subgraph Handlers["Handlers"]
            H1["session_start"]
            H2["inbound_message"]
            H3["task_fire"]
        end

        subgraph TurnEngine["Turn Loop"]
            TL["Turn Loop\n(bounded for-loop)"]
            MC["Model Call\n(Anthropic SDK)"]
            TC["Tool Calls\n(remember / ask / notify)"]
        end
    end

    RR["Reply Registry\n(LISTEN/NOTIFY)"]
    OAI["OpenAI\n(embeddings)"]
    ANT["Anthropic\n(claude-sonnet)"]
    OTEL["OTel Collector"]

    Client -->|POST /trigger| RT
    RT -->|write envelope| TE
    RT -->|enqueue session_start| WQ
    RT -->|subscribe| RR

    Client -->|POST /agents| RA
    RA -->|insert| AGT

    WL -->|FOR UPDATE SKIP LOCKED| WQ
    WL --> H1 & H2 & H3

    H1 -->|read payload| TE
    H1 -->|load| AGT
    H1 -->|create| SES
    H1 --> TL

    H2 -->|read| MSG
    H2 -->|load open session| SES
    H2 --> TL

    H3 -->|load| TSK
    H3 -->|create| SES
    H3 --> TL

    TL --> MC
    MC <-->|API call| ANT
    TL --> TC
    TC -->|insert| MEM
    TC -->|enqueue| WQ
    TL -->|upsert turn| TRN
    TL -->|close| SES

    SES -->|NOTIFY| RR
    RR -->|resume| RT
    RT -->|200 + final text| Client

    MEM <-->|embed| OAI
    Workers -->|spans / metrics / logs| OTEL
```

---

## 2. Request → Response Flow

Detailed sequence for a synchronous `POST /trigger` call.

```mermaid
sequenceDiagram
    participant C as Client
    participant H as HTTP /trigger
    participant RR as Reply Registry
    participant PG as PostgreSQL
    participant W as Worker
    participant A as Anthropic API
    participant OAI as OpenAI Embedding

    C->>H: POST /trigger {tenantId, agentId, content}
    H->>H: parse + validate (Zod → branded types)
    H->>PG: INSERT trigger_envelopes → envelope_id
    H->>PG: INSERT work_queue (kind=session_start, payload_ref=envelope_id)
    H->>RR: register(session_id, resolve)
    H-->>C: 202 (holds connection, waiting)

    W->>PG: SELECT work_queue FOR UPDATE SKIP LOCKED
    PG-->>W: work_item (lease acquired)
    W->>PG: SELECT trigger_envelopes WHERE id = payload_ref
    PG-->>W: full payload
    W->>PG: SELECT agents WHERE id = agent_id
    PG-->>W: {system_prompt, memory_params, hook_rules}

    W->>OAI: embed(user_message)
    OAI-->>W: query_vector[1536]
    W->>PG: SELECT memory ORDER BY embedding <-> query_vector LIMIT 128
    PG-->>W: candidates[]
    W->>W: re-rank by score (similarity × importance^α × recency)

    W->>PG: INSERT sessions (idempotent, ON CONFLICT IGNORE)
    PG-->>W: session_id

    loop Turn Loop (max 500 turns)
        W->>A: messages + tools + system_prompt
        A-->>W: {content[], stop_reason, usage}
        W->>PG: UPSERT turns (turn_index, response, usage)
        alt stop_reason = end_turn
            W->>W: break
        else stop_reason = tool_use
            W->>W: invoke tool
            Note over W: remember → INSERT memory<br/>ask → INSERT inbound_messages + enqueue<br/>notify → INSERT inbound_messages + enqueue
        end
    end

    W->>PG: UPDATE sessions SET closed_at = now()
    W->>PG: UPDATE work_queue SET completed_at = now()
    W->>PG: NOTIFY relay_session_closed (session_id)

    PG-->>RR: notification
    RR-->>H: resolve(final_text)
    H-->>C: 200 {text: "..."}
```

---

## 3. Turn Loop (State Machine)

```mermaid
stateDiagram-v2
    [*] --> BuildContext: session created

    BuildContext --> ModelCall: system_prompt + memories\n+ user message assembled

    ModelCall --> PersistTurn: API response received

    PersistTurn --> CheckStopReason

    CheckStopReason --> Done: stop_reason = end_turn
    CheckStopReason --> Error: stop_reason = max_tokens\nor turn limit hit
    CheckStopReason --> PreToolHook: stop_reason = tool_use

    PreToolHook --> InvokeTool: hook → approve
    PreToolHook --> Denied: hook → deny

    InvokeTool --> RememberTool: name = remember
    InvokeTool --> AskTool: name = ask
    InvokeTool --> NotifyTool: name = notify

    RememberTool --> AppendResult: embed + INSERT memory
    AskTool --> Suspend: enqueue inbound_message\nfor target session\n(session suspends)
    NotifyTool --> AppendResult: enqueue inbound_message\n(fire and forget)

    AppendResult --> PostToolHook
    PostToolHook --> ModelCall: hook → approve (loop back)
    PostToolHook --> Denied: hook → deny

    Suspend --> [*]: worker releases lease\nsession stays open

    Done --> CloseSession
    Error --> CloseSession
    Denied --> CloseSession

    CloseSession --> [*]: closed_at stamped\nNOTIFY emitted
```

---

## 4. Database Schema (ER)

```mermaid
erDiagram
    agents {
        uuid id PK
        uuid tenant_id
        text system_prompt
        jsonb tool_set
        jsonb hook_rules
        text memory_store_ref
        text hook_rules_ref
        float8 memory_default_importance
        int memory_half_life_days
        float8 memory_alpha
        timestamptz created_at
        timestamptz updated_at
    }

    sessions {
        uuid id PK
        uuid agent_id FK
        uuid tenant_id
        jsonb originating_trigger
        uuid parent_session_id FK
        uuid chain_id
        int depth
        uuid source_work_item_id
        timestamptz closed_at
        timestamptz created_at
        timestamptz updated_at
    }

    turns {
        uuid id PK
        uuid session_id FK
        uuid tenant_id
        uuid agent_id FK
        int turn_index
        timestamptz started_at
        timestamptz completed_at
        jsonb response
        jsonb tool_results
        jsonb usage
        timestamptz created_at
        timestamptz updated_at
    }

    tasks {
        uuid id PK
        uuid agent_id FK
        uuid tenant_id
        jsonb trigger_condition
        text intent
        timestamptz created_at
        timestamptz updated_at
    }

    work_queue {
        uuid id PK
        uuid tenant_id
        text kind
        text payload_ref
        timestamptz scheduled_at
        text leased_by
        timestamptz leased_until
        int attempts
        timestamptz completed_at
        timestamptz created_at
        timestamptz updated_at
    }

    trigger_envelopes {
        uuid id PK
        uuid tenant_id
        text kind
        jsonb payload
        timestamptz created_at
    }

    inbound_messages {
        uuid id PK
        uuid tenant_id
        uuid target_session_id FK
        text sender_type
        text sender_id
        text sender_display_name
        text kind
        text content
        timestamptz received_at
        uuid source_work_item_id
        timestamptz created_at
    }

    memory {
        uuid id PK
        uuid tenant_id
        uuid agent_id FK
        text kind
        text text
        vector1536 embedding
        float8 importance
        timestamptz created_at
        timestamptz last_retrieved_at
        int retrieval_count
    }

    agents ||--o{ sessions : "runs"
    agents ||--o{ turns : "produces"
    agents ||--o{ tasks : "has"
    agents ||--o{ memory : "owns"
    sessions ||--o{ turns : "contains"
    sessions ||--o{ inbound_messages : "receives"
    sessions }o--o| sessions : "parent_session_id"
```

---

## 5. Memory: Retrieval Scoring

How memories are ranked for injection into the opening context.

```mermaid
flowchart LR
    UM["User Message\n(trigger content)"]

    subgraph Embed["Embed (OpenAI)"]
        QV["query_vector\n[1536 dims]"]
    end

    subgraph ANN["ANN Fetch (HNSW)"]
        SQL["SELECT * FROM memory\nORDER BY embedding <-> query_vector\nLIMIT 128"]
        CAND["128 candidates"]
    end

    subgraph Rerank["Re-rank (app-side)"]
        SCORE["score =\nsimilarity(emb, qv)\n× importance^α\n× exp(−age / half_life)"]
        TOP["top 8 by score"]
    end

    INJECT["Inject into system prompt\n(≤ 4 KB, memory preamble)"]

    UM --> QV
    QV --> SQL
    SQL --> CAND
    CAND --> SCORE
    SCORE --> TOP
    TOP --> INJECT
```

**Score factors:**

| Factor       | Source                           | Column                         |
| ------------ | -------------------------------- | ------------------------------ |
| `similarity` | cosine distance (pgvector `<->`) | `memory.embedding`             |
| `importance` | agent-set or distilled (0–1)     | `memory.importance`            |
| `α`          | agent tuning parameter           | `agents.memory_alpha`          |
| `half_life`  | agent tuning parameter (days)    | `agents.memory_half_life_days` |
| `age_days`   | `now() - memory.created_at`      | computed                       |

---

## 6. Subsystem Dependency Graph

Import direction; no cycles.

```mermaid
graph BT
    subgraph Foundation["Foundation (no upstream deps)"]
        CORE["core/\nbrand · result · assert · clock · hash"]
        IDS["ids.ts\nbranded entity IDs"]
    end

    subgraph Infrastructure["Infrastructure"]
        DB["db/\npostgres pool · migrations · utils"]
        TEL["telemetry/\notel facade · spans · metrics · logs"]
    end

    subgraph Domain["Domain"]
        AGT["agent/\nload · create · parse"]
        MEM["memory/\nretrieve · insert · embed · remember-tool"]
        HOOK["hook/\ntypes · registry · run · evaluate · audit · pending"]
        WQ["work_queue/\nqueue · queue-ops · observability"]
    end

    subgraph Pipeline["Pipeline"]
        TRIG["trigger/\nhandlers · synthesize · payload · envelope-ops"]
        SES["session/\nturn-loop · model · tools · persistence"]
    end

    subgraph Entrypoints["Entrypoints"]
        HTTP["http/\napp · routes · reply-registry · server"]
        WORK["worker/\nmain · loop · dispatcher"]
    end

    CORE --> DB
    CORE --> TEL
    IDS --> DB
    IDS --> TEL

    DB --> AGT
    DB --> MEM
    DB --> HOOK
    DB --> WQ
    TEL --> AGT
    TEL --> MEM
    TEL --> WQ

    AGT --> TRIG
    MEM --> TRIG
    HOOK --> SES
    WQ --> TRIG
    WQ --> WORK

    TRIG --> SES
    SES --> TRIG

    TRIG --> HTTP
    TRIG --> WORK
    HTTP --> WORK
```

---

## 7. Work Queue & Lease Protocol

How distributed workers coordinate without external state.

```mermaid
sequenceDiagram
    participant W1 as Worker 1
    participant W2 as Worker 2
    participant PG as work_queue (PG)

    W1->>PG: SELECT ... FOR UPDATE SKIP LOCKED\nWHERE completed_at IS NULL\nAND (leased_until IS NULL OR leased_until < now())
    PG-->>W1: row (leased_by=W1, leased_until=now+30s)

    W2->>PG: SELECT ... FOR UPDATE SKIP LOCKED
    PG-->>W2: different row (W1's row is locked)

    Note over W1: processing...
    W1->>PG: UPDATE SET leased_until = now+30s (renew)

    Note over W1: crash / hang

    Note over W2: 30s passes, lease expires

    W2->>PG: SELECT ... FOR UPDATE SKIP LOCKED
    PG-->>W2: W1's row (lease expired, re-acquired)

    W2->>PG: UPDATE SET completed_at = now(), leased_by = NULL
```

**Key columns:**

| Column         | Meaning                                                              |
| -------------- | -------------------------------------------------------------------- |
| `leased_by`    | Worker ID holding the lease (`NULL` = available)                     |
| `leased_until` | Expiry timestamp; past = available for re-lease                      |
| `completed_at` | `NULL` = pending/in-flight; set = done (excluded from dequeue)       |
| `attempts`     | Incremented on each lease; surface in metrics                        |
| `payload_ref`  | Points at `trigger_envelopes.id` (≤ 512 bytes; not the full payload) |
