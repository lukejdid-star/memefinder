import { Connection, Commitment } from '@solana/web3.js';
import { config } from '../config';
import { logger } from './logger';

let connection: Connection | null = null;

export function getConnection(commitment: Commitment = 'confirmed'): Connection {
  if (!connection) {
    connection = new Connection(config.SOLANA_RPC_URL, {
      commitment,
      confirmTransactionInitialTimeout: 60_000,
    });
    logger.info('Solana RPC connection established', { url: config.SOLANA_RPC_URL.replace(/api-key=.*/, 'api-key=***') });
  }
  return connection;
}

export async function getSlot(): Promise<number> {
  return getConnection().getSlot();
}

export async function getBlockTime(slot: number): Promise<number | null> {
  return getConnection().getBlockTime(slot);
}
