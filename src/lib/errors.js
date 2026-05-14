export function friendlyError(error, fallback = 'Something went wrong. Please try again.') {
  const message = String(error?.message || error || '').toLowerCase()

  if (message.includes('wallet does not match')) {
    return 'This session is signed in with another wallet. Sign out, then reconnect the right wallet.'
  }
  if (message.includes('rejected') || message.includes('denied') || error?.code === 4001) {
    return 'Request cancelled.'
  }
  if (message.includes('insufficient')) {
    return 'Insufficient funds.'
  }
  if (message.includes('chain') || message.includes('network')) {
    return 'Switch to the required network and try again.'
  }
  if (message.includes('timeout') || message.includes('timed out')) {
    return 'Request timed out. Please try again.'
  }
  if (
    message.includes('schema cache') ||
    message.includes('check constraint') ||
    message.includes('violates') ||
    message.includes('duplicate key') ||
    message.includes('null value') ||
    message.includes('relation') ||
    message.includes('column') ||
    message.includes('expected pattern') ||
    message.includes('not a function')
  ) {
    return fallback
  }

  return error?.message || fallback
}
