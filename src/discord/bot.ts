import { Client, GatewayIntentBits, TextChannel, EmbedBuilder } from 'discord.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { TokenScore } from '../scoring/tokenScorer';

let client: Client | null = null;
let channel: TextChannel | null = null;

export async function startBot(): Promise<void> {
  if (!config.DISCORD_BOT_TOKEN || !config.DISCORD_CHANNEL_ID) {
    throw new Error('DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID must be set in .env');
  }

  client = new Client({ intents: [GatewayIntentBits.Guilds] });

  return new Promise((resolve, reject) => {
    client!.once('ready', async () => {
      logger.info(`Discord bot logged in as ${client!.user?.tag}`);

      const fetched = await client!.channels.fetch(config.DISCORD_CHANNEL_ID);
      if (!fetched || !fetched.isTextBased()) {
        reject(new Error(`Channel ${config.DISCORD_CHANNEL_ID} not found or is not a text channel`));
        return;
      }

      channel = fetched as TextChannel;
      logger.info(`Discord alerts will be sent to #${channel.name}`);
      resolve();
    });

    client!.once('error', (err) => {
      reject(err);
    });

    client!.login(config.DISCORD_BOT_TOKEN).catch(reject);
  });
}

export async function sendTokenAlert(token: TokenScore, safe: boolean): Promise<void> {
  if (!channel) {
    logger.warn('Discord channel not ready, skipping embed alert');
    return;
  }

  const pumpfunUrl = `https://pump.fun/coin/${token.mintAddress}`;
  const dexscreenerUrl = `https://dexscreener.com/solana/${token.mintAddress}`;

  // Color: green if safe + score >= 80, yellow if safe + score < 80, red if unsafe
  let color: number;
  if (!safe) {
    color = 0xff0000; // red
  } else if (token.compositeScore >= 80) {
    color = 0x00ff00; // green
  } else {
    color = 0xffff00; // yellow
  }

  const safetyTag = safe ? 'PASSED' : 'WARNING';

  const embed = new EmbedBuilder()
    .setTitle(`MEME TOKEN ALERT — $${token.symbol}`)
    .setColor(color)
    .setDescription(`**${token.name}** ($${token.symbol})\nTrend: "${token.trendKeyword}"`)
    .addFields(
      {
        name: 'Contract Address',
        value: `\`${token.mintAddress}\``,
      },
      {
        name: 'Score',
        value: `**${token.compositeScore.toFixed(1)}** / 100`,
        inline: true,
      },
      {
        name: 'Safety',
        value: safetyTag,
        inline: true,
      },
      {
        name: 'Score Breakdown',
        value: [
          `Social CA Mentions: ${token.socialCAMentions.toFixed(1)}`,
          `Pump.fun Engagement: ${token.pumpfunEngagement.toFixed(1)}`,
          `On-chain Health: ${token.onchainHealth.toFixed(1)}`,
          `Trend Alignment: ${token.trendAlignment.toFixed(1)}`,
          `Safety Score: ${token.safetyScore.toFixed(1)}`,
        ].join('\n'),
      },
      {
        name: 'Details',
        value: [
          `CA Mentions: ${token.details.caMentionCount}`,
          `Holders: ${token.details.holderCount}`,
          `Top 10 Conc: ${(token.details.top10Concentration * 100).toFixed(1)}%`,
          `Buy Ratio: ${(token.details.buyRatio * 100).toFixed(1)}%`,
          `Bonding Curve: ${(token.details.bondingCurveProgress * 100).toFixed(1)}%`,
          `Replies: ${token.details.replyCount}`,
          `Liquidity: $${token.details.liquidityUsd.toLocaleString()}`,
        ].join('\n'),
      },
      {
        name: 'Links',
        value: `[Pump.fun](${pumpfunUrl}) | [DexScreener](${dexscreenerUrl})`,
      },
    )
    .setTimestamp();

  try {
    await channel.send({ embeds: [embed] });
  } catch (err: any) {
    logger.error('Failed to send Discord embed', { error: err.message });
  }
}
