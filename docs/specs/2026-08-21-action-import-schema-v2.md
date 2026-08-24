# Action Import Schema v2

`/actions → Actions → Import from .md…` reads a Markdown file and creates reusable
**actions** in the current study. Moves, objects, subclasses and roles the file
names that the study lacks are **added on import** (the preview lists them under
"Will also add"); questions and their options must already exist — a question
needs a kind and options the file cannot express, so define those on the
Questions tab first.

Implementation: parser/planner `lib/actions/import.ts` (pure, unit-tested in
`lib/actions/__tests__/import.test.ts`), server actions
`app/actions/action-import.ts` (`previewActionImport` / `commitActionImport`),
UI `components/actions/ImportActionsPanel.tsx`.

## File format

- The file declares `schema_version: 2` once (bare line or inside a ```` ```yaml ```` fence).
- Each action is one fenced ```` ```action ```` block of YAML. Anything outside the
  fences (headings, prose) is ignored.

```action
name: "<required string>"
description: "<optional string>"

move: "<required existing move name>"      # exactly one move

objects:                                   # at least one; as many as the move needs
  - object: "<existing top-level object name>"
    subclass: "<optional existing subclass of that object>"
    role: "<optional existing role name>"

questions:                                 # optional; required questions must appear
  - question: "<existing question prompt>"
    answer:
      type: "option" | "text"              # optional — inferred from the question
      value: "<option label or free text>"
```

`answer` may also be a bare scalar (`answer: No`) and an objects entry may be a bare
string (`- Entity`) — both shorthands are accepted.

## Rules

- `name` must be non-empty; whitespace is trimmed. The name is **not** the action's
  identity and need not be unique.
- Identity is the composition signature (`compositionKey`): move, object set, each
  object's role, and the answers. A block whose signature already exists in the
  study is reported as *exists* and skipped; a block repeating an earlier block in
  the same file is reported as *repeat* and skipped. Re-importing a file is
  therefore idempotent.
- Names are matched trimmed and case/whitespace-insensitively (an exact match wins
  if that is ambiguous). A subclass must be written as `object: Parent,
  subclass: Child`; the importer tells you so if you name the subclass as the object.
- **Missing vocabulary is added, not refused.** A move, top-level object, subclass
  (under an existing or also-new parent) or role that does not match anything in the
  study is collected into the plan's `vocabAdds` (deduped case-insensitively, first
  spelling kept), the block is resolved against that provisional vocabulary, and on
  commit the server creates those rows first (`createMove` with `min_objects = 1`,
  `createRole`, `createObject` tops then subclasses), reloads, re-plans, and then
  creates the actions. Vocabulary is only added for blocks that would otherwise
  create cleanly — a block that also names an unknown question adds nothing. An
  ambiguous name, or a subclass written as the object, is still an error.
- An object may appear once per action (one role per object). The same move's
  `min_objects`, required questions, and option membership are enforced exactly as
  in the New-action form (`validateActionDraft`).
- Preview first: every block is classified as create / exists / repeat / error
  with reasons and the block's starting line. Nothing is written until
  **Import N actions** is clicked; blocks with errors are left out, the rest are
  created in file order through the ordinary `createAction` path.

## Example

````markdown
# Action Import

```yaml
schema_version: 2
```

```action
name: "Trace user story to entity"
description: "Links a user story to the entity it names"
move: "Trace"
objects:
  - object: "Scenario"
    subclass: "User story"
    role: "source"
  - object: "Entity"
    role: "target"
questions:
  - question: "What was the outcome?"
    answer:
      type: option
      value: "Action"
```

```action
name: "Create specification"
move: "Create"
objects:
  - object: "Specification"
```
````
