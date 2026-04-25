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

Keep each brief tight. No filler. This is a command briefing, not a tutorial.

IMPORTANT — After the tactical brief, output a JSON block wrapped in <NOVA_ACTIONS> tags containing an array of executable actions the agent can take RIGHT NOW. Each action must map to one of these strategy types: staking, lending, liquidity, arbitrage, grid.

Example format:
<NOVA_ACTIONS>
[
  {"id": "nova-1", "codename": "PHOENIX", "strategy": "staking", "action": "stake", "amountPct": 15, "reason": "Epoch boundary in 2hrs — stake now for max rewards"},
  {"id": "nova-2", "codename": "HYDRA", "strategy": "arbitrage", "action": "execute", "amountPct": 10, "reason": "SOL/mSOL spread at 0.3% — immediate arb opportunity"}
]
</NOVA_ACTIONS>

Rules for actions:
- strategy must be one of: staking, lending, liquidity, arbitrage, grid
- action must be one of: stake, lend, provide, execute, grid
- amountPct is the suggested percentage of deployable balance (1-25 max)
- Each action must have a clear, specific reason
- Only suggest actions that are actionable RIGHT NOW, not speculative
- Maximum 3 actions per brief`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text;
  return text;
}

function parseNovaActions(briefText) {
  if (!briefText) return [];

  const match = briefText.match(/<NOVA_ACTIONS>\s*([\s\S]*?)\s*<\/NOVA_ACTIONS>/);
  if (!match) return [];

  try {
    const actions = JSON.parse(match[1]);
    if (!Array.isArray(actions)) return [];

    const validStrategies = ['staking', 'lending', 'liquidity', 'arbitrage', 'grid'];
    const validActions = ['stake', 'lend', 'provide', 'execute', 'grid'];

    return actions
      .filter(a =>
        a.id && a.codename && a.strategy && a.action && a.amountPct && a.reason &&
        validStrategies.includes(a.strategy) &&
        validActions.includes(a.action) &&
        a.amountPct >= 1 && a.amountPct <= 25
      )
      .slice(0, 3); // max 3 actions
  } catch (e) {
    console.error('Failed to parse NOVA actions JSON:', e.message);
    return [];
  }
}

function stripNovaActionTags(briefText) {
  if (!briefText) return briefText;
  return briefText.replace(/<NOVA_ACTIONS>[\s\S]*?<\/NOVA_ACTIONS>/, '').trim();
}

module.exports = { generateNovaBrief, parseNovaActions, stripNovaActionTags };
