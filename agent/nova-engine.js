const Anthropic = require('@anthropic-ai/sdk');

async function generateNovaBrief(context) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return 'NOVA OFFLINE — API key not configured';
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are NOVA, the strategic intelligence engine for STRATEGOS — an autonomous Solana DeFi agent.

Current agent context:
- Agent wallet balance: ${context.agentBalance} SOL
- Vault balance: ${context.vaultBalance} SOL
- Sweep threshold: ${context.sweepThreshold} SOL
- Risk level: ${context.riskLevel}
- Active strategies: Liquid staking, lending, LP provisioning, arbitrage, grid trading

Your mission: Generate 3 UNCONVENTIONAL, creative, and legally sound strategies to maximize SOL accumulation that a standard DeFi bot would NOT think of. Think outside normal yield farming. Consider:

- Timing-based opportunities (network congestion patterns, validator reward cycles, epoch boundaries)
- Social/behavioral arbitrage (token launches, community events, NFT drops with SOL liquidity effects)
- Cross-protocol inefficiencies (composability gaps between protocols not yet exploited)
- Validator economics (MEV opportunities, stake delegation timing)
- Synthetic positions (using lending + LP to create leveraged yield without liquidation risk)
- Liquidity timing (providing LP during predictably high-volume events for amplified fees)
- Governance token farming (protocols rewarding early/active participants with tokens convertible to SOL)

Format your response as a TACTICAL BRIEF. For each strategy:
CODENAME: [single word, military style]
OPPORTUNITY: [1 sentence — what the opportunity is]
MECHANISM: [2-3 sentences — exactly how to execute it]
EDGE: [1 sentence — why this is non-obvious]
RISK: [1 sentence — the main downside]
TIMELINE: [e.g. "Deploy within 48hrs" or "Epoch-dependent"]

Keep each brief tight. No filler. This is a command briefing, not a tutorial.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text;
}

module.exports = { generateNovaBrief };
