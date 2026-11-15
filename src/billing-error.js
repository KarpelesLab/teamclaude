const INSPECTION_LIMIT = 64 * 1024;

/**
 * Inspect an error response for an account billing refusal. The returned body
 * replays every byte so other errors can be relayed unchanged.
 * @param {ReadableStream<Uint8Array>|null} body
 */
export async function inspectBillingError(body) {
  if (!body) return { billingError: false, body };
  const reader = body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let length = 0;
  let ended = false;
  let billingError = false;

  try {
    while (length <= INSPECTION_LIMIT) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      chunks.push(value);
      length += value.byteLength;
    }
  } catch (error) {
    reader.releaseLock();
    throw error;
  }

  if (ended && length <= INSPECTION_LIMIT) {
    try {
      const data = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
      const error = data?.error;
      billingError = data?.type === 'error' && (error?.type === 'billing_error'
        || (error?.type === 'invalid_request_error' && typeof error.message === 'string'
          && error.message.startsWith('Your credit balance is too low to access the Anthropic API.')));
    } catch { billingError = false; }
  }

  return {
    billingError,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (ended) { reader.releaseLock(); controller.close(); }
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) { reader.releaseLock(); controller.close(); }
        else controller.enqueue(value);
      },
      cancel(reason) { return ended ? Promise.resolve() : reader.cancel(reason); },
    }),
  };
}
