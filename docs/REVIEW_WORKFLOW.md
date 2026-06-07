# Review Workflow

We will use a separated-builder / separated-reviewer workflow.

## Rule

The same agent or person who implements a milestone should not be the only reviewer for that milestone.

## Default workflow

1. **Spec pass**
   - confirm milestone scope
   - confirm acceptance criteria
   - confirm test/demo target

2. **Builder pass**
   - one builder agent or person implements the milestone
   - keep diff small and scoped
   - builder writes a short implementation note

3. **Reviewer pass**
   - a different agent or person reviews the diff
   - review for correctness, safety, clarity, and architectural drift
   - reviewer tries to break assumptions

4. **Demo/verification pass**
   - verify against the real visible Chrome use case
   - confirm no fake side-browser regression

## Recommended agent split

- **Builder:** Claude Code or Codex session focused on implementation
- **Reviewer:** a separate session or separate agent run that did not author the code
- **Orchestrator:** Gary/OpenClaw keeps scope disciplined and compares build vs review findings

## Review checklist

- Does this still control the real Windows Chrome path?
- Did we accidentally drift into a separate managed browser?
- Is the API surface still minimal?
- Are pause/resume semantics understandable?
- Is localhost-only behavior preserved by default?
- Is the code readable enough for an open-source repo?

## Milestone policy

Every milestone should end with:
- implementation note
- reviewer note
- demo proof or blocker note

No milestone is considered done on builder confidence alone.
