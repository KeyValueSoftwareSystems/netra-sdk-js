export const INSTRUMENTATION_NAME = "netra.instrumentation.openai_agents";

export const NETRA_SPAN_TYPE_ATTR = "netra.span.type";

// Workflow attributes
export const NETRA_WORKFLOW_NAME = "netra.workflow.name";

// Agent attributes
export const NETRA_AGENT_NAME = "netra.agent.name";
export const NETRA_AGENT_HANDOFFS = "netra.agent.handoffs";
export const NETRA_AGENT_TOOLS = "netra.agent.tools";
export const NETRA_AGENT_OUTPUT_TYPE = "netra.agent.output_type";

// Agents SDK trace/span attributes
export const NETRA_AGENTS_GROUP_ID = "netra.agents.group_id";
export const NETRA_AGENTS_METADATA = "netra.agents.metadata";
export const NETRA_AGENTS_SPAN_TYPE = "netra.agents.span_type";
export const NETRA_AGENTS_PARENT_AGENT = "netra.agents.parent_agent";

// Handoff attributes
export const NETRA_HANDOFF_SOURCE_AGENT = "netra.handoff.source_agent";
export const NETRA_HANDOFF_TARGET_AGENT = "netra.handoff.target_agent";

// Guardrail attributes
export const NETRA_GUARDRAIL_NAME = "netra.guardrail.name";
export const NETRA_GUARDRAIL_TRIGGERED = "netra.guardrail.triggered";

// MCP attributes
export const NETRA_MCP_DATA = "netra.mcp.data";
export const NETRA_MCP_SERVER = "netra.mcp.server";

// Custom span attributes
export const NETRA_SPAN_NAME = "netra.span.name";
export const NETRA_CUSTOM_DATA = "netra.custom.data";

// GenAI semantic convention attributes not covered by shared SpanAttributes
export const GEN_AI_AGENT_NAME = "gen_ai.agent.name";
export const GEN_AI_TOOL_NAME = "gen_ai.tool.name";
export const GEN_AI_RESPONSE_ID = "gen_ai.response.id";
