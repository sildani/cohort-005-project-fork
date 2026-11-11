---
status: deprecated
---

> **Deprecated (2026-11-10).** Icons still come from `lucide-react`, but an icon library is cheap to change and not surprising, so it no longer earns an ADR. Kept as history; do not treat as a current decision.

# Use lucide-react for icons

We looked at Heroicons, Phosphor and Lucide. Lucide has the widest set and matches the shadcn/ui components we already use, so all icons come from `lucide-react`. Do not add a second icon library.
