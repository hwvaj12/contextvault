# Work items

Each work item is one file, `CV-<n>.md`, with YAML frontmatter the team-lead helper reads and a free-form body for notes, briefs and evidence. Only the lead writes these files.

## Fields

| Field | Required | Type | Meaning |
|---|---|---|---|
| `id` | yes | `CV-<n>` | Matches the file name |
| `title` | yes | text | One line |
| `milestone` | yes | text | The milestone it belongs to, or `setup` for work on the build system itself |
| `state` | yes | one of the states below | Only the lead changes it |
| `role` | yes | `scout`, `analyst`, `builder`, `checker`, `drafter`, `lead` or `none` | Who does the main piece |
| `size` | no | `S`, `M` or `L` | Rough size. An `L` item is a candidate for splitting. |
| `depends_on` | yes | list of item IDs, can be empty | Items that must close first |
| `provides` | no | list of contract names | Contracts this item writes |
| `consumes` | no | list of contract names | Contracts this item builds against |
| `touches` | yes | non-empty list of path globs | Paths the item may change, relative to the repo root |
| `done_when` | yes | text | The observable condition a checker proves |
| `acceptance` | no | list of step names | Milestone acceptance steps this item helps pass |
| `waiting_on` | no | `owner` or an item ID | Set when `state` is `blocked` |
| `default` | no | text | Proposed fallback; requires prior user authorization |
| `due` | no | date | Target date; grants no authorization |

States: `planned`, `ready`, `running`, `built`, `reviewed`, `merged`, `closed`, `blocked`, `partial`.

## How team-lead reads them

- An item depends on every ID in `depends_on`, plus the item that provides each contract it `consumes`. A contract is accepted when the item that provides it is closed.
- An item is ready to start when it's `planned` and everything it depends on is closed.
- Waves come from those dependencies. Wave 0 holds items with no dependencies, and each later wave holds items whose dependencies are all in earlier waves.
- The critical path is the longest chain of dependencies, counted in items. Ties go to the chain whose items have the lowest numbers.
- Two items get an overlap warning when their `touches` overlap and neither depends on the other, because they could run at the same time.

`team-lead helper plan-check` checks all of this and lists the items ready to start. `team-lead helper status` builds the progress view.

## Example

```markdown
---
id: CV-7
title: Endpoints for the public API
milestone: M1
state: ready
role: builder
size: M
depends_on: [CV-3]
consumes: [api-contract]
touches:
  - app/Http/**
done_when: >-
  Each endpoint in the API contract returns its documented shape,
  proven by feature tests that call it over HTTP.
---

Notes, briefs and evidence.
```
