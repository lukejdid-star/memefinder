import { PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { getConnection } from '../utils/solanaRpc';
import { rateLimiter } from './rateLimiter';
import { logger } from '../utils/logger';
import { config } from '../config';
import { checkBundleBuys, BundleCheckResult } from './bundleDetector';
import axios from 'axios';

export interface RugCheckResult {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  lpBurnedOrLocked: boolean;
  creatorNotSerial: boolean;
  notHoneypot: boolean;
  notBundled: boolean;
  overallSafe: boolean;
  reasons: string[];
}

export async function isSafe(mintAddress: string): Promise<boolean> {
  const result = await fullRugCheck(mintAddress);
  return result.overallSafe;
}

export async function fullRugCheck(mintAddress: string): Promise<RugCheckResult> {
  const reasons: string[] = [];

  // Run all checks in parallel (including GoPlus and bundle detection)
  const [mintCheck, creatorCheck, honeypotSafe, goPlusResult, bundleResult] = await Promise.all([
    checkMintAndFreeze(mintAddress),
    checkCreatorHistory(mintAddress),
    checkHoneypot(mintAddress),
    config.ENABLE_GOPLUS ? checkGoPlus(mintAddress) : Promise.resolve({ flagged: false, reasons: [] }),
    checkBundleBuys(mintAddress),
  ]);

  const result: RugCheckResult = {
    mintAuthorityRevoked: mintCheck.mintAuthorityRevoked,
    freezeAuthorityRevoked: mintCheck.freezeAuthorityRevoked,
    lpBurnedOrLocked: true, // Default to true for Pump.fun tokens (bonding curve)
    creatorNotSerial: creatorCheck,
    notHoneypot: honeypotSafe,
    notBundled: !bundleResult.isBundled,
    overallSafe: true,
    reasons,
  };

  // Critical checks — any failure = unsafe
  if (!result.mintAuthorityRevoked) {
    reasons.push('Mint authority NOT revoked — can inflate supply');
    result.overallSafe = false;
  }

  if (!result.freezeAuthorityRevoked) {
    reasons.push('Freeze authority NOT revoked — can freeze your tokens');
    result.overallSafe = false;
  }

  if (!result.creatorNotSerial) {
    reasons.push('Creator has launched 3+ tokens in 24h — likely serial scammer');
    result.overallSafe = false;
  }

  if (!result.notHoneypot) {
    reasons.push('Honeypot detected — sell simulation failed');
    result.overallSafe = false;
  }

  // GoPlus flags
  if (goPlusResult.flagged) {
    reasons.push(...goPlusResult.reasons);
    result.overallSafe = false;
  }

  // Bundle detection
  if (bundleResult.isBundled) {
    reasons.push(...bundleResult.reasons);
    result.overallSafe = false;
  }

  if (result.overallSafe) {
    logger.info('Rug check PASSED', { mint: mintAddress });
  } else {
    logger.warn('Rug check FAILED', { mint: mintAddress, reasons });
  }

  return result;
}

async function checkMintAndFreeze(mintAddress: string): Promise<{
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
}> {
  try {
    await rateLimiter.waitForSlot('helius');
    const conn = getConnection();
    const mintPubkey = new PublicKey(mintAddress);
    const mintInfo = await getMint(conn, mintPubkey);
    rateLimiter.reportSuccess('helius');

    return {
      mintAuthorityRevoked: mintInfo.mintAuthority === null,
      freezeAuthorityRevoked: mintInfo.freezeAuthority === null,
    };
  } catch (error: any) {
    rateLimiter.reportFailure('helius');
    logger.error('Mint/freeze check failed', { mint: mintAddress, error: error.message });
    // Default to unsafe if we can't check
    return { mintAuthorityRevoked: false, freezeAuthorityRevoked: false };
  }
}

async function checkCreatorHistory(mintAddress: string): Promise<boolean> {
  if (!config.HELIUS_API_KEY) return true; // Can't check without Helius

  try {
    await rateLimiter.waitForSlot('helius');

    // Use Helius enhanced API to get transaction history for the mint address
    const response = await axios.get(
      `https://api.helius.xyz/v0/addresses/${mintAddress}/transactions`,
      {
        params: {
          'api-key': config.HELIUS_API_KEY,
          limit: 1,
        },
        timeout: 10_000,
      },
    );

    rateLimiter.reportSuccess('helius');

    const txs = response.data || [];
    if (txs.length === 0) return true;

    // Get creator from the first (creation) transaction
    const creator = txs[0]?.feePayer;
    if (!creator) return true;

    // Check how many tokens this creator has launched recently
    await rateLimiter.waitForSlot('helius');

    const creatorTxs = await axios.get(
      `https://api.helius.xyz/v0/addresses/${creator}/transactions`,
      {
        params: {
          'api-key': config.HELIUS_API_KEY,
          limit: 20,
        },
        timeout: 10_000,
      },
    );

    rateLimiter.reportSuccess('helius');

    const recentCreations = (creatorTxs.data || []).filter((tx: any) => {
      const timestamp = tx.timestamp ? tx.timestamp * 1000 : 0;
      const within24h = Date.now() - timestamp < 24 * 60 * 60 * 1000;
      // Look for token creation transactions (Helius types for SPL token minting)
      const isCreation =
        tx.type === 'TOKEN_MINT' ||
        tx.type === 'CREATE' ||
        tx.type === 'INIT_MINT' ||
        tx.description?.toLowerCase().includes('create') ||
        tx.description?.toLowerCase().includes('mint');
      return within24h && isCreation;
    });

    if (recentCreations.length > 3) {
      logger.warn('Serial token creator detected', {
        creator,
        recentCreations: recentCreations.length,
      });
      return false;
    }

    return true;
  } catch (error: any) {
    rateLimiter.reportFailure('helius');
    logger.error('Creator history check failed', { error: error.message });
    return true; // Default to safe if check fails
  }
}

interface GoPlusResult {
  flagged: boolean;
  reasons: string[];
}

async function checkGoPlus(mintAddress: string): Promise<GoPlusResult> {
  try {
    await rateLimiter.waitForSlot('goplus');

    const response = await axios.get(
      'https://api.gopluslabs.com/api/v1/token_security/solana',
      {
        params: { contract_addresses: mintAddress },
        timeout: 10_000,
      },
    );

    rateLimiter.reportSuccess('goplus');

    const tokenData = response.data?.result?.[mintAddress.toLowerCase()]
      || response.data?.result?.[mintAddress]
      || null;

    if (!tokenData) {
      return { flagged: false, reasons: [] };
    }

    const reasons: string[] = [];

    if (tokenData.is_honeypot === '1') {
      reasons.push('GoPlus: token flagged as honeypot');
    }
    if (tokenData.is_open_source === '0' && tokenData.is_proxy === '1') {
      reasons.push('GoPlus: upgradeable proxy contract');
    }
    if (tokenData.can_take_back_ownership === '1') {
      reasons.push('GoPlus: owner can reclaim ownership');
    }
    if (tokenData.owner_change_balance === '1') {
      reasons.push('GoPlus: owner can change balances');
    }
    if (tokenData.hidden_owner === '1') {
      reasons.push('GoPlus: hidden owner detected');
    }
    if (tokenData.selfdestruct === '1') {
      reasons.push('GoPlus: contract can self-destruct');
    }
    if (tokenData.is_blacklisted === '1') {
      reasons.push('GoPlus: token is blacklisted');
    }
    if (tokenData.transfer_pausable === '1') {
      reasons.push('GoPlus: transfers can be paused');
    }

    return { flagged: reasons.length > 0, reasons };
  } catch (error: any) {
    rateLimiter.reportFailure('goplus', error?.response?.status);
    logger.error('GoPlus check failed', { mint: mintAddress, error: error.message });
    return { flagged: false, reasons: [] };
  }
}

async function checkHoneypot(mintAddress: string): Promise<boolean> {
  // Simulate a sell by getting a Jupiter quote for selling the token
  // If Jupiter can't quote a sell, it might be a honeypot
  try {
    await rateLimiter.waitForSlot('jupiter');

    const response = await axios.get(`${config.JUPITER_API_BASE}/quote`, {
      params: {
        inputMint: mintAddress,
        outputMint: config.SOL_MINT,
        amount: '1000000', // Small test amount
        slippageBps: 5000, // High slippage tolerance for test
      },
      timeout: 10_000,
    });

    rateLimiter.reportSuccess('jupiter');

    // If we got a quote, the token is sellable
    if (response.data?.outAmount && parseInt(response.data.outAmount) > 0) {
      return true;
    }

    return false;
  } catch (error: any) {
    rateLimiter.reportFailure('jupiter', error?.response?.status);

    // If the error is specifically "no route found", it could be a honeypot
    // or just a very new / illiquid token
    if (error?.response?.status === 400) {
      logger.warn('Honeypot check: no sell route found', { mint: mintAddress });
      return false;
    }

    // For other errors (network, etc.), give benefit of the doubt
    return true;
  }
}
