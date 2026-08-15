// Build a PostToolUse hookSpecificOutput response with replacement text.

function makeResponse(event, outputInfo, replacementText, additionalCtx) {
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
