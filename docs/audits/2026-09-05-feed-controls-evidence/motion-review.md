# Motion review

| Before | After | Why |
| --- | --- | --- |
| Carousel arrow translation, pressed scale and badge ornament | Static position/chevron control and quiet EDGE text | Repeated navigation should respond immediately. |
| Full-projections popup without a local origin | Radix trigger-derived transform origin | Preserve spatial connection to the activating button. |
| Old date strip | Calendar/game popovers with no new animation | Keyboard-driven calendar and search need immediate feedback. |

**Approve.** Changed motion reviewed against review-animations/STANDARDS.md. Native scroll-snap remains interruptible; reduced-motion disables smooth scrolling and movement. No animated layout properties were added. Inspect `ProjectionCard.css`, `EdgeIndicator.css`, `SummaryCarousel.tsx`, and `FeedToolbar.css`.
