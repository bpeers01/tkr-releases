// Build a PostToolUse hookSpecificOutput response with replacement text.

function makeResponse(event, outputInfo, replacementText, additionalCtx) {
  // A bare-array tool_response (the live MCP shape) must be written back as an
  // array. Spreading it into an object literal would yield {"0":{...}}, which
  // Claude Code silently ignores — the same failure mode as a bare string.
  if (outputInfo.rootArray) {
    const resp = {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: [{ type: "text", text: replacementText }],
      },
    };
    if (additionalCtx) resp.hookSpecificOutput.additionalContext = additionalCtx;
    return resp;
  }
  const updatedToolOutput = {
    ...event.tool_response,
  };
  if (outputInfo.field === "content" && outputInfo.asArray) {
    updatedToolOutput.content = [{ type: "text", text: replacementText }];
  } else {
    updatedToolOutput[outputInfo.field] = replacementText;
  }
  const resp = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput,
    },
  };
  if (additionalCtx) resp.hookSpecificOutput.additionalContext = additionalCtx;
  return resp;
}

module.exports = { makeResponse };
