import etherscanHandler from '../etherscan.js'

export default function handler(req, res) {
  req.query = { ...(req.query || {}), mintTime: 'detect' }
  return etherscanHandler(req, res)
}
