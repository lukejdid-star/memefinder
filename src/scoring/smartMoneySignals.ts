import { TTLCache } from '../utils/cache';

// Shared state: which smart wallets have bought which tokens
// Uses a 2-hour TTL to prevent unbounded memory growth
const walletSignals = new TTLCache<Set<string>>(2 * 60 * 60 * 1000);

export function recordSmartMoneyWallet(mintAddress: string, wallet: string): void {
  let wallets = walletSignals.get(mintAddress);
  if (!wallets) {
    wallets = new Set();
  }
  wallets.add(wallet);
  walletSignals.set(mintAddress, wallets);
}

export function getSmartMoneyWallets(mintAddress: string): string[] {
  const wallets = walletSignals.get(mintAddress);
  return wallets ? [...wallets] : [];
}
