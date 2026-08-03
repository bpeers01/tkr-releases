// Build a PostToolUse hookSpecificOutput response with replacement text.

function makeResponse(event, outputInfo, replacementText, additionalCtx) {
  const updatedToolResponse = {
    ...event.tool_response,
  };
  if (outputInfo.field === "content" && outputInfo.asArray) {
    updatedToolResponse.content = [{ type: "text", text: replacementText }];
  } else {
    updatedToolResponse[outputInfo.field] = replacementText;
  }
  const resp = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolResponse,
    },
  };
  if (additionalCtx) resp.hookSpecificOutput.additionalContext = additionalCtx;
  return resp;
}

module.exports = { makeResponse };
