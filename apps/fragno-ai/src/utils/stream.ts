export async function pipeNdjson(response: Response) {
  if (!response.body) {
    throw new Error("Stream response missing body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      if (line) {
        process.stdout.write(`${line}\n`);
      }
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  const remaining = buffer.trim();
  if (remaining) {
    process.stdout.write(`${remaining}\n`);
  }
}
