# langgraph-subgraph-sse-error

Minimal repro for [langchain-ai/langgraphjs#2570](https://github.com/langchain-ai/langgraphjs/issues/2570)
— `EventStreamCallbackHandler` throws `Run ID … not found in run map.` when a
compiled subgraph is used as a node in a parent `StateGraph` and the parent
streams events through `langgraphjs dev`.

## Quick start

```bash
pnpm install
cp .env.example .env  # fill in OPENAI_API_KEY (+ OPENAI_BASE_URL / OPENAI_MODEL if non-stock)
pnpm dev              # both processes run, combined log → ./log.txt
```

`pnpm dev` runs the langgraphjs dev server (`:3938`) and the SSE client in
parallel. All stdout/stderr lands in `./log.txt` — deleted and recreated on
each run. The client waits 10 s with a countdown before the first fetch so
the backend has time to register the graph.

If you want to inspect them separately:

```bash
pnpm dev:backend   # one terminal
pnpm dev:client    # another
```

## What the bug looks like

Inside `./log.txt` (or the backend terminal), look for lines like:

```
Error in handler EventStreamCallbackHandler, handleChainEnd:
  onChainEnd: Run ID <uuid> not found in run map.
Error in handler LangChainTracer, handleChainEnd: No chain run to end.
```

The error is thrown by `@langchain/core`'s event-stream tracer when the
compiled subgraph's chain ends inside the parent's event-stream context — the
run-id map has lost the subgraph's run id by the time `handleChainEnd` looks
it up.

Throw site: `node_modules/@langchain/core/dist/tracers/event_stream.cjs`,
around lines 247 / 289 / 358 — `onChainEnd`, `onToolEnd`,
`handleCustomEvent`.

## Topology

Mirrors `backend/agent.ts` from
[`langchain-ai/langgraph-app`](https://github.com/langchain-ai/langgraphjs/tree/main/examples)
in `USE_SUBGRAPH=true` shape, stripped down to one tool:

```
START
  ↓
routerAgent       — model.withStructuredOutput(zod, { method: "jsonSchema" })
  ↓ (conditional)
chatAgent (compiled subgraph)
  START → model → tools → model → ... → END
       ↑
       bindTools([get_time]) + ToolNode + toolsCondition
echoAgent (plain node)
  ↓
END
```

State is `StateSchema({ messages: MessagesValue, ... })` — same pattern as
`backend/state.ts` in the parent repo.

The compiled subgraph is the load-bearing piece: `addNode("chatAgent",
chatAgent)` where `chatAgent` is `new StateGraph(...).compile()`. Without
that boundary the bug does not fire.

## Versions pinned to the buggy stack

| package                          | version    |
| -------------------------------- | ---------- |
| `@langchain/core`                | `1.2.1`    |
| `@langchain/langgraph`           | `1.4.6`    |
| `@langchain/openai`              | `^1.5.0`   |
| `@langchain/langgraph-cli`       | `1.3.1`    |
| `@langchain/langgraph-checkpoint` | not needed |
| `zod`                            | `^4.0.0`   |

Bump `@langchain/core` past the version where the throw in
`dist/tracers/event_stream.cjs` is gone, and the error disappears — that's
the upstream fix to track.

## Notes for maintainers

- The `pnpm dev:client` waits 10 s before the first fetch (with a visible
  countdown) and retries twice more on failure. The dev server takes a
  moment to bind and register the graph after `langgraphjs dev` boots.
- The `echoAgent` plain-node path is included only so the router has a
  second destination — it's not load-bearing for the bug.
- If you're hitting `Malformed args` on every streaming tool-call chunk,
  that's a different bug — your OpenAI-compatible gateway is sending the
  function `name` field as `""` on every chunk, which the OpenAI parser
  rejects. Try stock OpenAI or a gateway that streams tool calls per the
  OpenAI spec (`name` once, `arguments` streamed).
- `pnpm typecheck` runs `tsc --noEmit` against `tsconfig.json`
  (`moduleResolution: bundler`, `types: [node]`, `skipLibCheck`).