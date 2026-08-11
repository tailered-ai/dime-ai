# Pre-image: TOS-004 task page (3b89673313e781bc982ae651c0b80747)
Fetched: 2026-08-10T23:29:29.932Z
URL: https://app.notion.com/p/3b89673313e781bc982ae651c0b80747

## Relevant content before mutation

### Required work packet section
## Required work packet
Every agent-executable task must answer: what, why, human owner, exact scope, non-goals, source system, definition of done, validation, blockers, and next action.

### Ready-completeness rule section (target line)
- **Execution Mode** is set; if AI Agent or Automation, **AI Executor** links the governed registry actor.

### Full Ready-completeness rule section
## Ready-completeness rule
A Task may be set to Execution State **Ready** (agent-executable) only when ALL of these are present — an agent resolving a Ready task with any of them missing must refuse and route back to the human owner:
- **What Done Means** (observable done condition) and **Why It Matters** are filled.
- **Owner** is a human (AI agents execute; they are never accountable owners) and **Scope ID** is set (`TOS-###` for Tailered OS work).
- **Execution Mode** is set; if AI Agent or Automation, **AI Executor** links the governed registry actor.
- The task body carries the execution packet: **Validation** (how done is proven) and **Non-goals** (what must not change).
- **Waiting On** is empty, or every blocker is explicitly accepted in **Why It's Blocked**.
At terminal: **Proof / Result** must link evidence before Status becomes Done; **Merged** (Execution State) covers "merged, validation pending" — Verified only after post-merge validation.
