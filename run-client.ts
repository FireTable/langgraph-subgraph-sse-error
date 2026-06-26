// ponytail: HTTP SSE client against the langgraphjs dev server.
// Waits 10s for the backend to come up (countdown shown), retries once on
// failure, then surfaces the raw SSE bytes — same as the browser would see.

import "dotenv/config";

const API_URL = process.env.LANGGRAPH_API_URL ?? "http://localhost:3938";
const ASSISTANT_ID = process.env.NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID ?? "agent";

process.on("uncaughtException", (err) => { console.error("\n[uncaughtException]", err); });
process.on("unhandledRejection", (err) => { console.error("\n[unhandledRejection]", err); });

async function countdown(seconds: number, label: string): Promise<void> {
  console.log(`[client] ${label}`);
  for (let i = seconds; i > 0; i--) {
    process.stdout.write(`\r[client] ${label} (${i}s)   `);
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.stdout.write(`\r[client] ${label} — retrying now.            \n`);
}

async function fetchOrWait(url: string, init: RequestInit): Promise<Response> {
  // First attempt — give the dev server 10s to bind and register the graph.
  await countdown(10, "warming up — backend may still be registering graphs");

  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      const reason = (err as Error).message || "network error";
      if (attempt >= 3) {
        throw new Error(`fetch ${url} failed after 3 attempts: ${reason}`);
      }
      console.error(`[client] fetch failed (${reason})`);
      await countdown(10, `retrying (attempt ${attempt + 1}/3)`);
    }
  }
}

async function main() {
  console.log(`[client] target: ${API_URL}, assistant_id: ${ASSISTANT_ID}`);
  console.log("[client] hint: backend logs are at ./log.txt — grep there for the run-map bug.");

  // 1) Create a thread.
  const threadRes = await fetchOrWait(`${API_URL}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!threadRes.ok) {
    throw new Error(`Failed to create thread: ${threadRes.status} ${await threadRes.text()}`);
  }
  const thread = (await threadRes.json()) as { thread_id: string };
  console.log(`[client] thread created: ${thread.thread_id}`);

  // 2) Stream a run via SSE.
  const runRes = await fetch(`${API_URL}/threads/${thread.thread_id}/runs/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      assistant_id: ASSISTANT_ID,
      input: { messages: [{ role: "user", content: "what time is it?" }] },
      stream_mode: "events",
    }),
  });

  if (!runRes.ok || !runRes.body) {
    throw new Error(`Run stream failed: ${runRes.status} ${await runRes.text()}`);
  }

  console.log(`[client] streaming run (status ${runRes.status}, content-type ${runRes.headers.get("content-type")})...\n`);

  const reader = runRes.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    process.stdout.write(decoder.decode(value, { stream: true }));
  }

  console.log("\n\n[client] stream ended.");
}

main().catch((err) => {
  console.error("\nRun failed:", err);
  process.exit(1);
});