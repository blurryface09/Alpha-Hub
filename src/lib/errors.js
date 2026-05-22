export function friendlyError(error, fallback = 'Something went wrong. Please try again.') {
  const message = String(error?.message || error || '').toLowerCase()

  if (message.includes('wallet does not match')) {
    return 'This session is signed in with another wallet. Sign out, then reconnect the right wallet.'
  }
  if (message.includes('rejected') || message.includes('denied') || error?.code === 4001) {
    return 'Request cancelled.'
  }
  if (message.includes('insufficient funds') || message.includes('total cost') || message.includes('exceeds the balance') || message.includes('exceeds balance')) {
    return 'Insufficient ETH — top up your wallet and try again.'
  }
  if (message.includes('chain') || message.includes('network')) {
    return 'Switch to the required network and try again.'
  }
  if (message.includes('timeout') || message.includes('timed out')) {
    return 'Request timed out. Please try again.'
  }
  if (message.includes('nonce')) {
    return 'Transaction nonce error — reset your wallet pending transactions and try again.'
  }
  // Mint-specific — surface the real reason
  if (message.includes('no contract exists') || message.includes('no bytecode') || message.includes('contract not found')) {
    return 'No contract found at this address on the selected chain. Check the contract address.'
  }
  if (message.includes('seadrop mint not active') || message.includes('public drop not configured') || message.includes('not currently active')) {
    return 'This mint is not currently active. Check the official mint page for the correct time.'
  }
  if (message.includes('allowlist') || message.includes('not whitelisted') || message.includes('not eligible') || message.includes('merkle') || message.includes('not in whitelist')) {
    return 'Mint rejected — your wallet is not on the allowlist for this phase.'
  }
  if (message.includes('sale not active') || message.includes('sale is not active') || message.includes('not started') || message.includes('not open') || message.includes('mint closed') || message.includes('mint has not') || message.includes('minting is not') || message.includes('paused')) {
    return 'Mint is not open yet or has ended. Check the official mint page for the correct time.'
  }
  if (message.includes('already minted') || message.includes('max per wallet') || message.includes('max mint') || message.includes('limit reached') || message.includes('max tokens') || message.includes('token limit')) {
    return 'Max mints reached — this wallet has hit the limit for this mint.'
  }
  if (message.includes('simulation failed') || message.includes('execution reverted')) {
    return 'Mint simulation failed — contract rejected the transaction. The mint may be closed, gated by allowlist, or require the official mint site.'
  }
  if (message.includes('unknown mint function') || message.includes('no standard mint') || message.includes('could not detect the mint') || message.includes('contract mint function not found')) {
    return 'Could not detect the mint function. Use the official mint site directly.'
  }
  if (message.includes('max supply') || message.includes('sold out') || message.includes('exceeds max') || message.includes('supply exceeded')) {
    return 'Sold out — this mint has reached its maximum supply.'
  }
  if (message.includes('msg.value') || message.includes('wrong value') || message.includes('incorrect value') || message.includes('invalid price') || message.includes('wrong mint price')) {
    return 'Wrong mint price sent. Check the price on the official mint page and try again.'
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
