// api/agent-chat.js
// Node serverless function. Customers never see or need an Anthropic API key —
// AgentHost's own key is used here and usage is metered against their plan.

const PLAN_LIMITS = {
  free: 500,
  starter: 1000,
  pro: 6000,
  agency: 12000,
};

async function supabaseFetch(path, opts = {}) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  return res.json();
}

async function verifyUser(accessToken) {
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { agent_id, message, session_id, history } = req.body;
  const accessToken = (req.headers.authorization || "").replace("Bearer ", "");

  const user = await verifyUser(accessToken);
  if (!user) return res.status(401).json({ error: "Not signed in" });

  // Load the agent and confirm it belongs to this user
  const agents = await supabaseFetch(`agents?id=eq.${agent_id}&select=*`);
  const agent = agents[0];
  if (!agent || agent.user_id !== user.id) {
    return res.status(403).json({ error: "Agent not found" });
  }

  // Load plan + this month's usage
  const users = await supabaseFetch(`users?id=eq.${user.id}&select=plan,subscription_status`);
  const account = users[0];
  if (!account || account.subscription_status === "expired") {
    return res.status(402).json({ error: "Trial expired — upgrade to keep chatting." });
  }

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const usageThisMonth = await supabaseFetch(
    `usage_logs?user_id=eq.${user.id}&role=eq.assistant&created_at=gte.${monthStart.toISOString()}&select=id`
  );
  const limit = PLAN_LIMITS[account.plan] ?? PLAN_LIMITS.free;
  if (usageThisMonth.length >= limit) {
    return res.status(402).json({ error: `Monthly limit of ${limit} messages reached. Upgrade for more.` });
  }

  // Log the user's message
  await supabaseFetch("usage_logs", {
    method: "POST",
    body: JSON.stringify({ user_id: user.id, agent_id, role: "user", content: message }),
  });

  // Mark this account as active (resets the 30-day inactivity clock)
  await supabaseFetch(`users?id=eq.${user.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ last_active_at: new Date().toISOString() }),
  });

  // Call Claude with AgentHost's own key
  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: agent.model,
      max_tokens: 1024,
      system: agent.system_prompt,
      messages: [...(history || []), { role: "user", content: message }],
    }),
  });
  const data = await claudeRes.json();
  const reply = data.content?.[0]?.text || "Sorry, I couldn't generate a response.";

  // Log the assistant's reply
  await supabaseFetch("usage_logs", {
    method: "POST",
    body: JSON.stringify({ user_id: user.id, agent_id, role: "assistant", content: reply }),
  });

  return res.status(200).json({ reply });
}
