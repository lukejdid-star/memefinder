/**
 * One-time Telegram authentication script.
 * Run with: npm run telegram-auth
 *
 * This will:
 * 1. Connect to Telegram via MTProto
 * 2. Prompt you for your verification code
 * 3. Print a session string to copy into your .env as TELEGRAM_SESSION
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { config } from '../config';
import * as readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.trim()));
  });
}

async function main(): Promise<void> {
  const apiId = config.TELEGRAM_API_ID;
  const apiHash = config.TELEGRAM_API_HASH;
  const phone = config.TELEGRAM_PHONE;

  if (!apiId || !apiHash || !phone) {
    console.error('Error: TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_PHONE must be set in .env');
    process.exit(1);
  }

  console.log('Connecting to Telegram...');
  console.log(`API ID: ${apiId}`);
  console.log(`Phone: ${phone}`);

  const session = new StringSession('');
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.start({
    phoneNumber: () => Promise.resolve(phone),
    phoneCode: () => ask('Enter the verification code sent to your Telegram: '),
    password: () => ask('Enter your 2FA password (if enabled): '),
    onError: (err) => {
      console.error('Auth error:', err.message);
    },
  });

  const sessionString = client.session.save() as unknown as string;

  console.log('\n=== SUCCESS ===');
  console.log('Copy this session string into your .env file as TELEGRAM_SESSION:\n');
  console.log(sessionString);
  console.log('\n===============\n');

  await client.disconnect();
  rl.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
