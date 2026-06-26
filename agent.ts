import { END, START, StateGraph } from "@langchain/langgraph";
import { StateSchema, MessagesValue } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";

// ponytail: parent and subgraph states mirror backend/state.ts — use StateSchema +
// MessagesValue so the subgraph boundary speaks the same contract as the parent repo.

const ParentState = new StateSchema({
  messages: MessagesValue,
  routerDecision: z.object({ next: z.enum(["chatAgent", "echoAgent"]) }),
});

const ChatState = new StateSchema({
  messages: MessagesValue,
});

const model = new ChatOpenAI({
  model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  apiKey: process.env.OPENAI_API_KEY,
  ...(process.env.OPENAI_BASE_URL ? { configuration: { baseURL: process.env.OPENAI_BASE_URL } } : {}),
  streaming: true,
});

const RouterSchema = z.object({
  next: z.enum(["chatAgent", "echoAgent"]),
});

async function routerAgentNode({ messages }: { messages: BaseMessage[] }) {
  const decision = await model
    .withStructuredOutput(RouterSchema, { method: "jsonSchema" })
    .invoke([
      new SystemMessage(
        "Pick chatAgent when the user asks for anything that needs a tool (time, lookup, action). " +
        "Pick echoAgent for plain chitchat. Reply with JSON only.",
      ),
      ...messages,
    ]);
  return { routerDecision: decision };
}

// ponytail: tool accepts optional `timezone` so the LLM's emitted args don't trip
// "Malformed args" when it sends {} or {timezone: "UTC"} — exact-stringly-typed
// z.object({}) rejects any keys the model adds.
const getTimeTool = tool(
  async (_args: { timezone?: string }) => new Date().toISOString(),
  {
    name: "get_time",
    description: "Returns the current UTC time as an ISO 8601 string. Optional timezone arg.",
    schema: z.object({ timezone: z.string().describe("The timezone to use for the time."), __trigger: z.boolean().describe("Whether to trigger the tool, must be true") }),
  },
);

async function chatModelNode({ messages }: { messages: BaseMessage[] }) {
  const response = await model.bindTools([getTimeTool]).invoke(messages);
  return { messages: [response] };
}

const chatToolNode = new ToolNode([getTimeTool]);

function chatRoute({ messages }: { messages: BaseMessage[] }) {
  return toolsCondition({ messages }) === END ? END : "tools";
}

// ponytail: chatAgent is a compiled subgraph wired via .addNode("chatAgent", chatAgent) —
// same shape as backend/agent.ts buildSubgraph(). The subgraph boundary is what trips
// the EventStreamCallbackHandler run-map drift under @langchain/core@1.2.1.
const chatAgent = new StateGraph(ChatState)
  .addNode("model", chatModelNode)
  .addNode("tools", chatToolNode)
  .addEdge(START, "model")
  .addConditionalEdges("model", chatRoute, ["tools", END])
  .addEdge("tools", "model")
  .compile();

async function echoAgentNode({ messages }: { messages: BaseMessage[] }) {
  const reply = await model.invoke(messages);
  return { messages: [reply] };
}

function routeToSubAgent({ routerDecision }: { routerDecision: { next: "chatAgent" | "echoAgent" } }) {
  return routerDecision.next;
}

export const graph = new StateGraph(ParentState)
  .addNode("routerAgent", routerAgentNode)
  .addNode("chatAgent", chatAgent)
  .addNode("echoAgent", echoAgentNode)
  .addEdge(START, "routerAgent")
  .addConditionalEdges("routerAgent", routeToSubAgent, {
    chatAgent: "chatAgent",
    echoAgent: "echoAgent",
  })
  .addEdge("chatAgent", END)
  .addEdge("echoAgent", END)
  .compile();