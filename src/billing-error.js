/** Whether a complete JSON error body refuses the account's billing.
 * @param {Uint8Array|null} body */
export function isBillingError(body) {
  if (!body) return false;
  try {
    const data = JSON.parse(Buffer.from(body).toString('utf8'));
    const error = data?.error;
    return data?.type === 'error' && (error?.type === 'billing_error'
      || (error?.type === 'invalid_request_error' && typeof error.message === 'string'
        && error.message.startsWith('Your credit balance is too low to access the Anthropic API.')));
  } catch { return false; }
}
