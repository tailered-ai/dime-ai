# Pre-image: TOS-009 (3b89673313e7815aafcaeaebc32ea8dd), fetched 2026-08-10T19:59:31Z
Properties: Status=Not started, Execution State=Ready, Priority=P1, Work Link=https://github.com/tailered-ai/dime-ai

Body verbatim:
## State machine
Idea → Project → Task → Ready → Executing → PR Open → CI → Review → Human Approval → Merge → Deploy or No Deploy → Validate → Result → Learning → Next Task.
## Safety
Automations never silently continue after failed validation. Every event uses a durable identifier so retries are safe.

(No Validation/Non-goals sections pre-mutation. Mutation = append both at end.)
